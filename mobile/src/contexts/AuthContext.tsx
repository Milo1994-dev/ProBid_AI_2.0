import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { api, saveToken, clearToken, loadToken, setAuthExpiredHandler, refreshTokenIfNeeded, UserData } from '../api/client';
import { registerForPushNotifications, refreshPushToken } from '../services/notifications';

const BIOMETRIC_PREF_KEY = 'probid_biometric_enabled';

export async function isBiometricAvailable(): Promise<boolean> {
  const compatible = await LocalAuthentication.hasHardwareAsync();
  if (!compatible) return false;
  const enrolled = await LocalAuthentication.isEnrolledAsync();
  return enrolled;
}

export async function getBiometricPreference(): Promise<boolean> {
  try {
    const val = await SecureStore.getItemAsync(BIOMETRIC_PREF_KEY);
    return val === 'true';
  } catch {
    return false;
  }
}

export async function setBiometricPreference(enabled: boolean): Promise<void> {
  await SecureStore.setItemAsync(BIOMETRIC_PREF_KEY, enabled ? 'true' : 'false');
}

interface AuthContextValue {
  user: UserData | null;
  loading: boolean;
  sessionExpired: boolean;
  authError: string | null;
  biometricLocked: boolean;
  login: (
    email: string,
    password: string,
    ref?: string,
  ) => Promise<{
    success: boolean;
    error?: string;
  }>;
  signup: (
    email: string,
    password: string,
    ref?: string,
  ) => Promise<{
    success: boolean;
    error?: string;
  }>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  unlockWithBiometric: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function getApiErrorMessage(err: unknown, fallback: string): { error: string; retryAfter?: number } {
  if (err instanceof Error) {
    const apiErr = err as ApiError;
    return {
      error: apiErr.apiError ?? apiErr.message ?? fallback,
      retryAfter: apiErr.retryAfter,
    };
  }
  return { error: fallback };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserData | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [biometricLocked, setBiometricLocked] = useState(false);
  const hasResumedRef = useRef(false);

  const handleAuthExpired = useCallback(() => {
    setUser(null);
    setSessionExpired(true);
    clearToken();
  }, []);

  useEffect(() => {
    setAuthExpiredHandler(handleAuthExpired);
  }, [handleAuthExpired]);

  const unlockWithBiometric = useCallback(async (): Promise<boolean> => {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Unlock ProBid AI',
      fallbackLabel: 'Use Passcode',
      disableDeviceFallback: false,
    });
    if (result.success) {
      setBiometricLocked(false);
      return true;
    }
    return false;
  }, []);

  const loadUser = useCallback(async () => {
    try {
      setAuthError(null);
      const token = await loadToken();
      if (!token) {
        setUser(null);
        setLoading(false);
        return;
      }
      await refreshTokenIfNeeded();
      const res = await api.getMe();
      if (res.success && res.data) {
        setUser(res.data);
        registerForPushNotifications();

        const bioPref = await getBiometricPreference();
        const bioAvailable = await isBiometricAvailable();
        if (bioPref && bioAvailable && !hasResumedRef.current) {
          setBiometricLocked(true);
        }
        hasResumedRef.current = true;
      } else {
        setUser(null);
        await clearToken();
      }
    } catch (err: unknown) {
      setUser(null);
      const message = err instanceof Error ? err.message : 'Unable to connect. Please try again.';
      setAuthError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUser();
  }, [loadUser]);

  useEffect(() => {
    const prevStateRef = { current: AppState.currentState };

    const handleAppStateChange = async (nextState: AppStateStatus) => {
      const prevState = prevStateRef.current;
      prevStateRef.current = nextState;

      if (
        nextState === 'active' &&
        (prevState === 'background' || prevState === 'inactive') &&
        user
      ) {
        refreshPushToken();
        const bioPref = await getBiometricPreference();
        const bioAvailable = await isBiometricAvailable();
        if (bioPref && bioAvailable) {
          setBiometricLocked(true);
        }
      }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription.remove();
  }, [user]);

  const login = useCallback(
    async (
      email: string,
      password: string,
      ref?: string,
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      try {
        const res = await api.login(email, password, ref);
        if (res.success && res.data?.token) {
          await saveToken(res.data.token);
          setUser({ id: res.data.id, email: res.data.email, affiliateCode: null, hasSeenOnboarding: null });
          setSessionExpired(false);
          hasResumedRef.current = true;
          setBiometricLocked(false);
          await loadUser();
          return { success: true };
        }
        return { success: false, error: res.error ?? 'Login failed' };
      } catch (err: unknown) {
        return { success: false, ...getApiErrorMessage(err, 'Login failed') };
      }
    },
    [loadUser],
  );

  const signup = useCallback(
    async (
      email: string,
      password: string,
      ref?: string,
    ): Promise<{
      success: boolean;
      error?: string;
    }> => {
      try {
        const res = await api.signup(email, password, ref);
        if (res.success && res.data?.token) {
          await saveToken(res.data.token);
          setUser({ id: res.data.id, email: res.data.email, affiliateCode: null, hasSeenOnboarding: null });
          setSessionExpired(false);
          hasResumedRef.current = true;
          setBiometricLocked(false);
          await loadUser();
          return { success: true };
        }
        return { success: false, error: res.error ?? 'Signup failed' };
      } catch (err: unknown) {
        return { success: false, ...getApiErrorMessage(err, 'Signup failed') };
      }
    },
    [loadUser],
  );

  const logout = useCallback(async () => {
    await clearToken();
    setUser(null);
    hasResumedRef.current = false;
    setBiometricLocked(false);
  }, []);

  const refreshUser = useCallback(async () => {
    await loadUser();
  }, [loadUser]);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        sessionExpired,
        authError,
        biometricLocked,
        login,
        signup,
        logout,
        refreshUser,
        unlockWithBiometric,
      }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { api } from "../api/client";
import { clearCsrfToken } from "../api/client";

interface User {
  id: string;
  email: string;
  affiliateCode: string | null;
  hasSeenOnboarding: boolean | null;
  pdfShowGuaranteeBadges: boolean | null;
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  sessionExpired: boolean;
  login: (email: string, password: string, ref?: string) => Promise<{ success: boolean; error?: string }>;
  signup: (email: string, password: string, ref?: string, metaEventId?: string) => Promise<{ success: boolean; error?: string }>;
  verify: (email: string, code: string, mode: "login" | "signup", ref?: string, metaEventId?: string) => Promise<{ success: boolean; error?: string; retryAfter?: number }>;
  resendCode: (email: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);

  const loadUser = useCallback(async () => {
    try {
      const res = await api.getMe();
      if (res.success && res.data) {
        setUser(res.data);
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUser();
  }, [loadUser]);

  useEffect(() => {
    const handle = () => {
      setUser(null);
      setSessionExpired(true);
    };
    window.addEventListener("auth:expired", handle);
    return () => window.removeEventListener("auth:expired", handle);
  }, []);

  const login = useCallback(
    async (email: string, password: string, ref?: string): Promise<{ success: boolean; error?: string }> => {
      try {
        const res = await api.login(email, password, ref);
        if (res.success && res.data) {
          await loadUser();
          setSessionExpired(false);
          return { success: true };
        }
        return { success: false, error: res.error ?? "Login failed" };
      } catch (err: any) {
        return { success: false, error: err?.apiError ?? err?.message ?? "Login failed" };
      }
    },
    [loadUser]
  );

  const signup = useCallback(
    async (email: string, password: string, ref?: string, metaEventId?: string): Promise<{ success: boolean; error?: string }> => {
      try {
        const res = await api.signup(email, password, ref, metaEventId);
        if (res.success && res.data) {
          await loadUser();
          setSessionExpired(false);
          return { success: true };
        }
        return { success: false, error: res.error ?? "Signup failed" };
      } catch (err: any) {
        return { success: false, error: err?.apiError ?? err?.message ?? "Signup failed" };
      }
    },
    [loadUser]
  );

  const verify = useCallback(
    async (email: string, code: string, mode: "login" | "signup", ref?: string, metaEventId?: string): Promise<{ success: boolean; error?: string; retryAfter?: number }> => {
      try {
        const res = await api.verify(email, code, mode, ref, metaEventId);
        if (res.success && res.data) {
          await loadUser();
          setSessionExpired(false);
          return { success: true };
        }
        return { success: false, error: res.error ?? "Verification failed" };
      } catch (err: any) {
        return { success: false, error: err?.apiError ?? err?.message ?? "Verification failed", retryAfter: err?.retryAfter };
      }
    },
    [loadUser]
  );

  const resendCode = useCallback(
    async (email: string): Promise<{ success: boolean; error?: string }> => {
      try {
        const res = await api.resendCode(email);
        if (res.success) return { success: true };
        return { success: false, error: res.error ?? "Failed to resend code" };
      } catch (err: any) {
        return { success: false, error: err?.apiError ?? err?.message ?? "Failed to resend code" };
      }
    },
    []
  );

  const logout = useCallback(async () => {
    await api.logout();
    clearCsrfToken();
    setUser(null);
    window.location.href = "/";
  }, []);

  const refreshUser = useCallback(async () => {
    await loadUser();
  }, [loadUser]);

  return (
    <AuthContext.Provider
      value={{ user, loading, sessionExpired, login, signup, verify, resendCode, logout, refreshUser }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

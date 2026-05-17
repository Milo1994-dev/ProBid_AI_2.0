import React, { useEffect, useRef } from 'react';
import { StatusBar } from 'expo-status-bar';
import { AppState, AppStateStatus } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from './src/contexts/AuthContext';
import { NetworkProvider, onConnectivityRestored } from './src/contexts/NetworkContext';
import AppNavigator from './src/navigation/AppNavigator';
import { processQueue } from './src/services/offlineQueue';

export default function App() {
  const appState = useRef(AppState.currentState);

  useEffect(() => {
    const unsubReconnect = onConnectivityRestored(() => {
      processQueue();
    });

    const subscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      if (appState.current.match(/inactive|background/) && nextState === 'active') {
        processQueue();
      }
      appState.current = nextState;
    });

    return () => {
      unsubReconnect();
      subscription.remove();
    };
  }, []);

  return (
    <SafeAreaProvider>
      <NetworkProvider>
        <AuthProvider>
          <StatusBar style="light" />
          <AppNavigator />
        </AuthProvider>
      </NetworkProvider>
    </SafeAreaProvider>
  );
}

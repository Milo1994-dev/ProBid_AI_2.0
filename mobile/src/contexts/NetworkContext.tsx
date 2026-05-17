import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';

interface NetworkContextValue {
  isConnected: boolean;
  isInternetReachable: boolean | null;
}

const NetworkContext = createContext<NetworkContextValue>({
  isConnected: true,
  isInternetReachable: true,
});

type ConnectivityListener = () => void;

const connectivityListeners: ConnectivityListener[] = [];

export function onConnectivityRestored(listener: ConnectivityListener): () => void {
  connectivityListeners.push(listener);
  return () => {
    const idx = connectivityListeners.indexOf(listener);
    if (idx >= 0) connectivityListeners.splice(idx, 1);
  };
}

export function NetworkProvider({ children }: { children: React.ReactNode }) {
  const [isConnected, setIsConnected] = useState(true);
  const [isInternetReachable, setIsInternetReachable] = useState<boolean | null>(true);
  const wasDisconnected = useRef(false);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state: NetInfoState) => {
      const connected = state.isConnected ?? false;
      const reachable = state.isInternetReachable;

      setIsConnected(connected);
      setIsInternetReachable(reachable);

      const notReachable = reachable === false || reachable === null;
      if (!connected || (reachable !== null && reachable === false)) {
        wasDisconnected.current = true;
      } else if (wasDisconnected.current && connected && !notReachable) {
        wasDisconnected.current = false;
        connectivityListeners.forEach((fn) => {
          try { fn(); } catch {}
        });
      }
    });

    return () => unsubscribe();
  }, []);

  return (
    <NetworkContext.Provider value={{ isConnected, isInternetReachable }}>
      {children}
    </NetworkContext.Provider>
  );
}

export function useNetwork(): NetworkContextValue {
  return useContext(NetworkContext);
}

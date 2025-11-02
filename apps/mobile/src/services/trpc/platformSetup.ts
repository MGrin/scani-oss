import { focusManager, onlineManager } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { AppStateStatus } from 'react-native';
import { AppState, Platform } from 'react-native';

interface NetworkState {
  isConnected?: boolean;
}

export function setupOnlineManager() {
  try {
    const Network = require('expo-network');
    onlineManager.setEventListener((setOnline) => {
      const subscription = Network.addNetworkStateListener((state: NetworkState) => {
        setOnline(!!state.isConnected);
      });
      return subscription.remove;
    });
  } catch (_error) {
    console.log('expo-network not available, skipping online manager setup');
    onlineManager.setOnline(true);
  }
}

export function useAppFocusManager() {
  useEffect(() => {
    const onAppStateChange = (status: AppStateStatus) => {
      if (Platform.OS !== 'web') {
        focusManager.setFocused(status === 'active');
      }
    };

    const subscription = AppState.addEventListener('change', onAppStateChange);
    return () => subscription.remove();
  }, []);
}

import { useFonts } from '@expo-google-fonts/space-grotesk';
import { Slot, SplashScreen } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { initialWindowMetrics, SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider } from '@/contexts/AuthContext';
import { initI18n } from '@/i18n';
import { setupOnlineManager, useAppFocusManager } from '@/services/trpc/platformSetup';
import { TRPCProvider } from '@/services/trpc/trpcProvider';
import { ThemeProvider } from '@/theme/context';
import { customFontsToLoad } from '@/theme/typography';
import { initCrashReporting } from '@/utils/crashReporting';
import { loadDateFnsLocale } from '@/utils/formatDate';
import { logger } from '@/utils/logger';

SplashScreen.preventAutoHideAsync();

if (__DEV__) {
  // Load Reactotron configuration in development. We don't want to
  // include this in our production bundle, so we are using `if (__DEV__)`
  // to only execute this in development.
  require('@/devtools/ReactotronConfig');
}

// Initialize crash reporting (Sentry)
initCrashReporting();
logger.info('App initialization started');

export default function Root() {
  const [fontsLoaded, fontError] = useFonts(customFontsToLoad);
  const [isI18nInitialized, setIsI18nInitialized] = useState(false);

  useAppFocusManager();

  useEffect(() => {
    setupOnlineManager();
  }, []);

  useEffect(() => {
    initI18n()
      .then(() => {
        setIsI18nInitialized(true);
        logger.info('i18n initialized');
      })
      .then(() => loadDateFnsLocale())
      .catch((error) => {
        logger.error('Failed to initialize i18n', error);
      });
  }, []);

  const loaded = fontsLoaded && isI18nInitialized;

  useEffect(() => {
    if (fontError) {
      logger.error('Font loading error', fontError);
      throw fontError;
    }
  }, [fontError]);

  useEffect(() => {
    if (loaded) {
      logger.info('App ready, hiding splash screen');
      SplashScreen.hideAsync();
    }
  }, [loaded]);

  if (!loaded) {
    return null;
  }

  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <ThemeProvider>
        <AuthProvider>
          <TRPCProvider>
            <KeyboardProvider>
              <Slot />
            </KeyboardProvider>
          </TRPCProvider>
        </AuthProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

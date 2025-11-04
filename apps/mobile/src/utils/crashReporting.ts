import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';

/**
 * Initialize Sentry crash reporting for production
 * Expo https://docs.expo.dev/guides/using-sentry/
 */
export const initCrashReporting = () => {
  const sentryDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

  if (!sentryDsn) {
    if (!__DEV__) {
      console.warn('Sentry DSN not configured. Error tracking disabled.');
    }
    return;
  }

  Sentry.init({
    dsn: sentryDsn,
    debug: __DEV__,
    environment: __DEV__ ? 'development' : 'production',
    enableAutoSessionTracking: true,
    sessionTrackingIntervalMillis: 30000,
    enableNative: true,
    enableNativeCrashHandling: true,
    tracesSampleRate: __DEV__ ? 1.0 : 0.2,
    attachStacktrace: true,
    normalizeDepth: 10,
    maxBreadcrumbs: 50,
    dist: Constants.expoConfig?.version,
    release: `${Constants.expoConfig?.slug}@${Constants.expoConfig?.version}`,
    integrations: [
      Sentry.reactNativeTracingIntegration({
        enableUserInteractionTracing: true,
        enableNativeFramesTracking: true,
      }),
    ],
    beforeSend(event) {
      if (__DEV__) {
        console.log('Sentry Event:', event);
      }
      return event;
    },
  });
};

/**
 * Error classifications used to sort errors on error reporting services.
 */
export enum ErrorType {
  /**
   * An error that would normally cause a red screen in dev
   * and force the user to sign out and restart.
   */
  FATAL = 'Fatal',
  /**
   * An error caught by try/catch where defined using Reactotron.tron.error.
   */
  HANDLED = 'Handled',
}

/**
 * Manually report a handled error.
 */
export const reportCrash = (error: Error, type: ErrorType = ErrorType.FATAL) => {
  if (__DEV__) {
    // Log to console and Reactotron in development
    const message = error.message || 'Unknown';
    console.error(error);
    console.log(message, type);
  } else {
    // In production, utilize crash reporting service of choice below:
    // RN
    // Sentry.captureException(error)
    // crashlytics().recordError(error)
    // Bugsnag.notify(error)
  }
};

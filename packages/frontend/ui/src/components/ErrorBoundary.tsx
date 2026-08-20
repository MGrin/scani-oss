import type { ErrorInfo, ReactNode } from 'react';
import { Component } from 'react';
import { uiT } from '../i18n';
import { userFacingMessage } from '../lib/user-facing-error';

/**
 * Minimal error boundary used across both Scani SPAs. Takes an optional
 * `onError` callback so apps can pipe errors to their own Sentry client
 * (avoids hard-wiring @sentry/react into shared code — different SPAs may
 * run different Sentry projects).
 *
 * It shows the caught error's message only when somebody wrote that message
 * for a reader (SC-311). A component's assertion — `useTheme must be used
 * within a ThemeProvider` — used to render here verbatim, in English, on the
 * one screen the installed PWA gives no way to leave (SC-62, SC-73).
 */

interface Props {
  children: ReactNode;
  onError?: (error: Error, info: ErrorInfo) => void;
  /** Button label + href for the fallback "return home" CTA. */
  homeLabel?: string;
  homeHref?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Exported for its own test: a boundary's fallback is the one path that only
 * renders when something has already gone wrong, so it is exactly the markup
 * least likely to be exercised by hand.
 */
export function CrashFallback({
  error,
  homeLabel,
  onGoHome,
}: {
  error: Error | null;
  homeLabel?: string;
  onGoHome: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-4 text-center">
        <h1 className="text-2xl font-bold text-foreground">{uiT('ui.errors.crash.title')}</h1>
        <p className="text-muted-foreground">
          {userFacingMessage(error) ?? uiT('ui.errors.crash.detail')}
        </p>
        <button
          type="button"
          onClick={onGoHome}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          {homeLabel ?? uiT('ui.errors.crash.home')}
        </button>
      </div>
    </div>
  );
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
    this.props.onError?.(error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      const homeHref = this.props.homeHref ?? '/';
      return (
        <CrashFallback
          error={this.state.error}
          homeLabel={this.props.homeLabel}
          onGoHome={() => {
            this.setState({ hasError: false, error: null });
            window.location.href = homeHref;
          }}
        />
      );
    }

    return this.props.children;
  }
}

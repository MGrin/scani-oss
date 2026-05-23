import type { ErrorInfo, ReactNode } from 'react';
import { Component } from 'react';

/**
 * Minimal error boundary used across both Scani SPAs. Takes an optional
 * `onError` callback so apps can pipe errors to their own Sentry client
 * (avoids hard-wiring @sentry/react into shared code — different SPAs may
 * run different Sentry projects).
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
      const homeLabel = this.props.homeLabel ?? 'Go to Dashboard';
      const homeHref = this.props.homeHref ?? '/';
      return (
        <div className="flex min-h-screen items-center justify-center bg-background p-4">
          <div className="w-full max-w-md space-y-4 text-center">
            <h1 className="text-2xl font-bold text-foreground">Something went wrong</h1>
            <p className="text-muted-foreground">
              {this.state.error?.message || 'An unexpected error occurred.'}
            </p>
            <button
              type="button"
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.href = homeHref;
              }}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              {homeLabel}
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

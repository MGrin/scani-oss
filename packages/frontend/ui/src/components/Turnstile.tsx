import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

/**
 * Cloudflare Turnstile, the human check in front of every request that makes
 * Scani send mail without a session (SC-1266). With no site key it renders
 * nothing and sends no header, which is what every build gets until the key
 * exists; the server is equally inert until its secret is set.
 */

export const TURNSTILE_HEADER = 'x-turnstile-token';

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(id: string): void;
  remove(id: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export function turnstileHeaders(token: string | null | undefined): Record<string, string> {
  return token ? { [TURNSTILE_HEADER]: token } : {};
}

let scriptLoad: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptLoad ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile did not load'));
    script.onerror = () => {
      scriptLoad = null;
      reject(new Error('Turnstile did not load'));
    };
    document.head.appendChild(script);
  });
  return scriptLoad;
}

interface TurnstileWidgetProps {
  siteKey: string | undefined;
  /** A fresh token, or null when it expired or the check could not run. */
  onToken: (token: string | null) => void;
  onFailure?: () => void;
  /** Bump to ask for a new token; each one is single-use. */
  resetKey?: number;
}

export function TurnstileWidget({
  siteKey,
  onToken,
  onFailure,
  resetKey = 0,
}: TurnstileWidgetProps) {
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const handlers = useRef({ onToken, onFailure });
  handlers.current = { onToken, onFailure };

  useEffect(() => {
    if (!siteKey || !container.current) return;
    let cancelled = false;
    const fail = () => {
      handlers.current.onToken(null);
      handlers.current.onFailure?.();
    };
    loadTurnstile()
      .then((api) => {
        if (cancelled || !container.current) return;
        widgetId.current = api.render(container.current, {
          sitekey: siteKey,
          callback: (token: string) => handlers.current.onToken(token),
          'expired-callback': () => handlers.current.onToken(null),
          'error-callback': fail,
        });
      })
      .catch(fail);
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [siteKey]);

  useEffect(() => {
    if (resetKey > 0 && widgetId.current && window.turnstile) {
      window.turnstile.reset(widgetId.current);
    }
  }, [resetKey]);

  if (!siteKey) return null;
  return <div data-ui="turnstile" ref={container} />;
}

export interface TurnstileState {
  /** False when no site key is configured: submit needs no token. */
  required: boolean;
  token: string | null;
  /** The script or the check failed; the form should say so. */
  failed: boolean;
  /** Spend the token: clears it and asks the widget for a new one. */
  reset: () => void;
  widget: ReactNode;
}

export function useTurnstile(siteKey: string | undefined): TurnstileState {
  const [token, setToken] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const onToken = useCallback((next: string | null) => {
    setToken(next);
    if (next) setFailed(false);
  }, []);
  const onFailure = useCallback(() => setFailed(true), []);
  const reset = useCallback(() => {
    setToken(null);
    setResetKey((k) => k + 1);
  }, []);
  return {
    required: Boolean(siteKey),
    token,
    failed,
    reset,
    widget: (
      <TurnstileWidget
        siteKey={siteKey}
        onToken={onToken}
        onFailure={onFailure}
        resetKey={resetKey}
      />
    ),
  };
}

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * The console sends people to `/auth?returnTo=<absolute console URL>` and the
 * app must send them back — but only to an allow-listed origin. Runs in the DOM
 * process `packages/frontend/ui/tests/helpers/dom-specs.ts` starts, because the
 * pages are effects-driven.
 *
 * The env and the mocks are in place before the modules under test load: the
 * allow-list is read from `VITE_CLOUD_URL` once, at import.
 */
process.env.VITE_CLOUD_URL = 'https://cloud.scani.xyz/';

const magicLink = mock(async (_args: { email: string; callbackURL: string }) => ({ error: null }));
mock.module('@/lib/auth-client', () => ({
  authClient: {
    getSession: async () => ({ data: null }),
    signIn: { magicLink },
  },
}));
mock.module('@/lib/trpc', () => ({
  trpc: { demo: { status: { useQuery: () => ({ data: undefined, isLoading: false }) } } },
}));

const { AuthContext } = await import('@/contexts/auth-context');
const { AuthProvider, useAuth } = await import('@/contexts/AuthContext');
const { Auth } = await import('@/pages/Auth');
const { AuthCallback } = await import('@/pages/AuthCallback');

const CONSOLE_KEYS = 'https://cloud.scani.xyz/keys';

const assign = mock((_url: string) => {});
Object.defineProperty(window.location, 'assign', { value: assign, configurable: true });

const signedIn = {
  user: { id: 'u1', email: 'a@b.co' },
  loading: false,
  status: 'authenticated',
  authenticate: async () => ({}),
  verifyCode: async () => ({}),
} as unknown as NonNullable<React.ContextType<typeof AuthContext>>;

async function mount(node: ReactNode): Promise<string> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  const html = container.innerHTML;
  await act(async () => root.unmount());
  container.remove();
  return html;
}

function signedInAt(location: string): Promise<string> {
  return mount(
    <AuthContext.Provider value={signedIn}>
      <MemoryRouter initialEntries={[location]}>
        <Routes>
          <Route path="/" element={<p>HOME</p>} />
          <Route path="/auth" element={<Auth />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>
  );
}

beforeEach(() => assign.mockClear());

const signedOut = { ...signedIn, user: null, status: 'anonymous' } as typeof signedIn;

/** Installed-PWA sign-in: email, then the six-digit code pasted in. */
async function signInWithCodeAt(location: string): Promise<string> {
  const realMatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === '(display-mode: standalone)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <AuthContext.Provider value={signedOut}>
          <MemoryRouter initialEntries={[location]}>
            <Routes>
              <Route path="/" element={<p>HOME</p>} />
              <Route path="/auth" element={<Auth />} />
            </Routes>
          </MemoryRouter>
        </AuthContext.Provider>
      );
    });
    const email = container.querySelector('input[type="email"], input[name="email"]');
    if (!(email instanceof HTMLInputElement)) throw new Error('no email input');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        email,
        'a@b.co'
      );
      email.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true }));
    });
    const digit = container.querySelector('input[inputmode="numeric"]');
    if (!digit) throw new Error('code screen never rendered');
    await act(async () => {
      const paste = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(paste, 'clipboardData', { value: { getData: () => '123456' } });
      digit.dispatchEvent(paste);
    });
    return container.innerHTML;
  } finally {
    await act(async () => root.unmount());
    container.remove();
    window.matchMedia = realMatchMedia;
  }
}

describe('leaving sign-in for the Cloud console', () => {
  test('/auth with an allow-listed returnTo assigns the console URL', async () => {
    await signedInAt(`/auth?returnTo=${CONSOLE_KEYS}`);
    expect(assign.mock.calls).toEqual([[CONSOLE_KEYS]]);
  });

  test('the installed-app code path assigns the console URL too', async () => {
    const html = await signInWithCodeAt(`/auth?returnTo=${CONSOLE_KEYS}`);
    expect(assign.mock.calls).toEqual([[CONSOLE_KEYS]]);
    expect(html).not.toContain('HOME');
  });

  test('/auth with a returnTo on another origin stays in the app', async () => {
    const html = await signedInAt('/auth?returnTo=https://evil.example/keys');
    expect(assign).not.toHaveBeenCalled();
    expect(html).toContain('HOME');
  });

  test('/auth/callback with an encoded allow-listed returnTo assigns the console URL', async () => {
    await signedInAt(`/auth/callback?returnTo=${encodeURIComponent(CONSOLE_KEYS)}`);
    expect(assign.mock.calls).toEqual([[CONSOLE_KEYS]]);
  });

  test('/auth/callback with a rejected returnTo falls back to the app', async () => {
    const html = await signedInAt(
      `/auth/callback?returnTo=${encodeURIComponent('https://evil.example/')}`
    );
    expect(assign).not.toHaveBeenCalled();
    expect(html).toContain('HOME');
  });
});

describe('an expired magic link', () => {
  const expired = { ...signedOut, status: 'anonymous' } as typeof signedOut;

  async function retryHrefAt(location: string): Promise<string | null> {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <AuthContext.Provider value={expired}>
          <MemoryRouter initialEntries={[location]}>
            <Routes>
              <Route path="/auth/callback" element={<AuthCallback />} />
            </Routes>
          </MemoryRouter>
        </AuthContext.Provider>
      );
    });
    const href = container.querySelector('a')?.getAttribute('href') ?? null;
    await act(async () => root.unmount());
    container.remove();
    return href;
  }

  test('Try again keeps an allow-listed returnTo', async () => {
    const href = await retryHrefAt(`/auth/callback?returnTo=${encodeURIComponent(CONSOLE_KEYS)}`);
    expect(href).toBe(`/auth?returnTo=${encodeURIComponent(CONSOLE_KEYS)}`);
  });

  test('Try again drops a rejected returnTo', async () => {
    const href = await retryHrefAt(
      `/auth/callback?returnTo=${encodeURIComponent('https://evil.example/')}`
    );
    expect(href).toBe('/auth');
  });

  test('Try again with no returnTo stays plain /auth', async () => {
    expect(await retryHrefAt('/auth/callback')).toBe('/auth');
  });
});

describe('the magic link carries the returnTo through the email', () => {
  function Sender() {
    const { authenticate } = useAuth();
    return (
      <button type="button" onClick={() => void authenticate('a@b.co')}>
        send
      </button>
    );
  }

  async function sendFrom(search: string): Promise<string> {
    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(
      `https://app.scani.xyz/auth${search}`
    );
    magicLink.mockClear();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <AuthProvider>
            <Sender />
          </AuthProvider>
        </QueryClientProvider>
      );
    });
    await act(async () => {
      container.querySelector('button')?.click();
    });
    await act(async () => root.unmount());
    container.remove();
    const call = magicLink.mock.calls[0];
    if (!call) throw new Error('signIn.magicLink was never called');
    return call[0].callbackURL;
  }

  test('an allow-listed returnTo rides on the callback URL', async () => {
    const callbackURL = await sendFrom(`?returnTo=${encodeURIComponent(CONSOLE_KEYS)}`);
    expect(callbackURL).toContain(`returnTo=${encodeURIComponent(CONSOLE_KEYS)}`);
    expect(new URL(callbackURL).pathname).toBe('/auth/callback');
  });

  test('a rejected returnTo is dropped, leaving the callback URL as before', async () => {
    const callbackURL = await sendFrom('?returnTo=https://evil.example/');
    expect(callbackURL).toBe('https://app.scani.xyz/auth/callback');
  });
});

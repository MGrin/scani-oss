import { afterEach, describe, expect, jest, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * SC-1752: the person's time in the passkey prompt is not a network wait. A
 * phone over hybrid/QR routinely takes longer than the 15 s auth deadline, and
 * the screen said "took too long, check your connection".
 */
const PROMPT_MS = 20_000;
let passkeyAnswer: () => Promise<{ data: unknown; error: unknown }>;
const passkey = mock((_opts: unknown) => passkeyAnswer());
const getSession = mock(async () => ({ data: null }));
mock.module('@/lib/auth-client', () => ({
  authClient: {
    getSession,
    signIn: { passkey, magicLink: mock(async () => ({ error: null })) },
  },
}));
// Every `*.dom.tsx` shares one process and `mock.module` outlives this file,
// so stub only `demo` and hand the rest to the real client.
const realTrpc = (await import('@/lib/trpc')).trpc;
const demo = { status: { useQuery: () => ({ data: undefined, isLoading: false }) } };
mock.module('@/lib/trpc', () => ({
  trpc: new Proxy(realTrpc, {
    get: (target, key) => (key === 'demo' ? demo : Reflect.get(target, key)),
  }),
}));

const { AuthProvider, useAuth } = await import('@/contexts/AuthContext');

type Auth = ReturnType<typeof useAuth>;

async function withAuth(run: (auth: Auth) => Promise<void>): Promise<void> {
  let auth: Auth | null = null;
  function Probe() {
    auth = useAuth();
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </QueryClientProvider>
    );
  });
  try {
    if (!auth) throw new Error('useAuth never rendered');
    await run(auth);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

/** Settles `promise` while advancing fake time in steps, as a person would wait. */
async function waitThrough<T>(promise: Promise<T>, ms: number): Promise<T> {
  let settled = false;
  const watched = promise.finally(() => {
    settled = true;
  });
  for (let waited = 0; waited <= ms && !settled; waited += 1_000) {
    await act(async () => {
      jest.advanceTimersByTime(1_000);
    });
  }
  return watched;
}

afterEach(() => {
  jest.useRealTimers();
});

describe('signInWithPasskey (SC-1752)', () => {
  test('a person who takes 20 s in the passkey prompt is signed in, not told it took too long', async () => {
    passkeyAnswer = () =>
      new Promise((resolve) => setTimeout(() => resolve({ data: {}, error: null }), PROMPT_MS));
    await withAuth(async (auth) => {
      jest.useFakeTimers();
      const result = await waitThrough(auth.signInWithPasskey(), PROMPT_MS + 5_000);
      expect(result).toEqual({});
    });
  });

  test('a cancelled prompt reads as a passkey failure, never as the connection', async () => {
    passkeyAnswer = async () => ({
      data: null,
      error: { code: 'ERROR_CEREMONY_ABORTED', message: 'auth cancelled', status: 400 },
    });
    await withAuth(async (auth) => {
      const result = await auth.signInWithPasskey();
      expect(result.kind).toBe('server');
      expect(result.error).toBe(
        "This device couldn't use a passkey. Sign in with your email instead."
      );
    });
  });
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Toaster } from '@scani/ui/ui/toaster';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import i18n from 'i18next';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { trpc } from '@/lib/trpc';
import { AiCategorySettings } from '@/v3/components/settings/AiCategorySettings';

/**
 * The AI category suggestions switch in Settings (SC-1695): off by default,
 * what it sends always in view, and a click reaching the server. Runs in the
 * DOM process `dom-specs.ts` starts.
 */

const T = i18n.t.bind(i18n);

let calls: { path: string; input: unknown }[];
let enabled: boolean;
let available: boolean;
const realFetch = globalThis.fetch;

function respond(path: string, input: unknown): unknown {
  calls.push({ path, input });
  switch (path) {
    case 'users.getAiCategories':
      return { enabled, available };
    case 'users.setAiCategories':
      enabled = (input as { enabled: boolean }).enabled;
      return { enabled };
    default:
      return null;
  }
}

beforeEach(() => {
  calls = [];
  enabled = false;
  available = true;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, '')).split(',');
    const inputs = (
      init?.body ? JSON.parse(String(init.body)) : JSON.parse(url.searchParams.get('input') ?? '{}')
    ) as Record<string, unknown>;
    return Response.json(
      paths.map((path, index) => ({ result: { data: respond(path, inputs[String(index)]) } }))
    );
  }) as typeof fetch;
});

let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  globalThis.fetch = realFetch;
});

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const trpcClient = trpc.createClient({ links: [httpBatchLink({ url: 'http://api.test/trpc' })] });
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <trpc.Provider client={trpcClient} queryClient={client}>
        <QueryClientProvider client={client}>
          <AiCategorySettings />
          <Toaster />
        </QueryClientProvider>
      </trpc.Provider>
    );
  });
  await flush();
}

const text = () => (document.body.textContent ?? '').replace(/\s+/g, ' ');
const toggle = () => document.querySelector<HTMLButtonElement>('button[role="switch"]');

describe('the AI category suggestions switch', () => {
  test('off by default, and it says what is sent', async () => {
    await mount();
    expect(toggle()?.getAttribute('aria-checked')).toBe('false');
    expect(text()).toContain(T('v3.settings.aiCategories.sent'));
  });

  test('turning it on reaches the server', async () => {
    await mount();
    await act(async () => toggle()?.click());
    await flush();
    expect(calls.filter((c) => c.path === 'users.setAiCategories')).toEqual([
      { path: 'users.setAiCategories', input: { enabled: true } },
    ]);
    expect(toggle()?.getAttribute('aria-checked')).toBe('true');
  });

  test('a person who has it on can always turn it off, even with no AI provider', async () => {
    enabled = true;
    available = false;
    await mount();
    expect(toggle()?.disabled).toBe(false);
    await act(async () => toggle()?.click());
    await flush();
    expect(calls.filter((c) => c.path === 'users.setAiCategories')).toEqual([
      { path: 'users.setAiCategories', input: { enabled: false } },
    ]);
  });

  test('with no AI provider on this instance, the switch is disabled and says why', async () => {
    available = false;
    await mount();
    expect(toggle()?.disabled).toBe(true);
    expect(text()).toContain(T('v3.settings.aiCategories.unavailable'));
  });
});

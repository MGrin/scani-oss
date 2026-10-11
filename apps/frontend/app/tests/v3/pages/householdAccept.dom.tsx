import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Toaster } from '@scani/ui/ui/toaster';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { HouseholdAcceptPage } from '@/v3/pages/HouseholdAcceptPage';

/**
 * The invite landing (SC-1647), mounted against a stubbed tRPC endpoint. An
 * open invite names the household and who sent it and offers Accept; an
 * expired one says so and offers nothing to press. Runs in the DOM process
 * `packages/frontend/ui/tests/helpers/dom-specs.ts` starts.
 */

let state: 'open' | 'expired' | 'revoked' | 'used';
let calls: { path: string; input: unknown }[];
const realFetch = globalThis.fetch;

function respond(path: string, input: unknown): unknown {
  calls.push({ path, input });
  if (path === 'household.previewInvite') {
    return { householdName: 'The Grins', inviterName: 'Alice', state };
  }
  return null;
}

beforeEach(() => {
  calls = [];
  state = 'open';
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
          <MemoryRouter initialEntries={['/household/accept?token=shh_abc']}>
            <Routes>
              <Route path="/household/accept" element={<HouseholdAcceptPage />} />
            </Routes>
          </MemoryRouter>
          <Toaster />
        </QueryClientProvider>
      </trpc.Provider>
    );
  });
  await act(async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function text(): string {
  return (document.body.textContent ?? '').replace(/\s+/g, ' ');
}

const buttons = () => [...document.querySelectorAll('button')].map((b) => b.textContent?.trim());

describe('the household invite page', () => {
  test('an open invite names the household and the inviter, and offers Accept', async () => {
    await mount();

    expect(calls.find((c) => c.path === 'household.previewInvite')?.input).toEqual({
      token: 'shh_abc',
    });
    expect(text()).toContain('The Grins');
    expect(text()).toContain('Alice');
    expect(buttons()).toContain('Accept');
  });

  test('an expired invite says so and offers no Accept', async () => {
    state = 'expired';
    await mount();

    expect(text()).toContain('This invite has expired');
    expect(buttons()).not.toContain('Accept');
  });
});

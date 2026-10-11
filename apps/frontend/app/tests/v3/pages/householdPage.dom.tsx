import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { HouseholdPage } from '@/v3/pages/HouseholdPage';

/**
 * The household view (SC-1647), mounted against a stubbed tRPC endpoint. It
 * names the household currency beside the total, labels every account with its
 * owner, and says when two members track one account. Runs in the DOM process
 * `packages/frontend/ui/tests/helpers/dom-specs.ts` starts.
 */

let calls: { path: string; input: unknown }[];
let member = true;
const NOT_FOUND = Symbol('not found');
const realFetch = globalThis.fetch;

const VIEW = {
  baseCurrencyId: 'usd',
  baseCurrencySymbol: 'USD',
  total: '500',
  allocation: [{ id: 'crypto', code: 'crypto', name: 'Crypto', value: '500', percentage: 100 }],
  accounts: [
    {
      accountId: 'a1',
      name: 'Joint',
      institutionName: 'Bank',
      ownerId: 'alice',
      ownerName: 'Alice',
      ownedByViewer: false,
      value: '200',
    },
    {
      accountId: 'b1',
      name: 'joint',
      institutionName: 'Bank',
      ownerId: 'bob',
      ownerName: 'Bob',
      ownedByViewer: true,
      value: '300',
    },
  ],
  trackedTwice: [{ accountIds: ['a1', 'b1'], reason: 'same-name' }],
};

function respond(path: string, input: unknown): unknown {
  calls.push({ path, input });
  if (!member && path.startsWith('household.')) return NOT_FOUND;
  if (path === 'household.view') return VIEW;
  if (path === 'household.history') {
    return {
      baseCurrencyId: 'usd',
      series: [
        { date: '2026-09-01', value: '450' },
        { date: '2026-09-02', value: '500' },
      ],
      unmeasuredDates: [],
    };
  }
  return null;
}

beforeEach(() => {
  calls = [];
  member = true;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, '')).split(',');
    const inputs = (
      init?.body ? JSON.parse(String(init.body)) : JSON.parse(url.searchParams.get('input') ?? '{}')
    ) as Record<string, unknown>;
    return Response.json(
      paths.map((path, index) => {
        const data = respond(path, inputs[String(index)]);
        if (data !== NOT_FOUND) return { result: { data } };
        return {
          error: {
            message: 'You are not in a household',
            code: -32004,
            data: { code: 'NOT_FOUND', httpStatus: 404, path },
          },
        };
      })
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

// `retries` mounts with react-query's own default of 3, so a test can see the page
// refuse to retry an answer that will not change.
async function mount({ retries = false }: { retries?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: retries ? {} : { retry: false } } });
  const trpcClient = trpc.createClient({ links: [httpBatchLink({ url: 'http://api.test/trpc' })] });
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <trpc.Provider client={trpcClient} queryClient={client}>
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={['/household']}>
            <Routes>
              <Route path="/household" element={<HouseholdPage />} />
            </Routes>
          </MemoryRouter>
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

describe('the household page', () => {
  test('names the household currency beside the total and asks for history', async () => {
    await mount();
    expect(text()).toContain('In USD');
    expect(calls.some((call) => call.path === 'household.view')).toBe(true);
    expect(calls.some((call) => call.path === 'household.history')).toBe(true);
  });

  test('labels every account with its owner, and the viewer’s own as theirs', async () => {
    await mount();
    expect(text()).toContain('Joint · Alice');
    expect(text()).toContain('joint · You');
  });

  test('tells a non-member they are not in a household, at once, and points to Settings', async () => {
    member = false;
    await mount({ retries: true });

    expect(text()).toContain('You are not in a household');
    expect(text()).not.toContain('could not be loaded');
    const link = [...document.querySelectorAll('a')].find((a) =>
      a.textContent?.includes('Settings')
    );
    expect(link?.getAttribute('href')).toBe('/settings');
    expect(calls.filter((call) => call.path === 'household.view')).toHaveLength(1);
  });

  test('says when two members track the same account', async () => {
    await mount();
    expect(text()).toContain('Both of you track Joint: un-share one copy');
  });
});

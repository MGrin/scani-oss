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
let unmeasuredOnly = false;
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
      institutionId: 'bank',
      institutionName: 'Bank',
      institutionWebsite: null,
      ownerId: 'alice',
      ownerName: 'Alice',
      ownedByViewer: false,
      value: '200',
    },
    {
      accountId: 'b1',
      name: 'joint',
      institutionId: 'bank',
      institutionName: 'Bank',
      institutionWebsite: null,
      ownerId: 'bob',
      ownerName: 'Bob',
      ownedByViewer: true,
      value: '300',
    },
  ],
  trackedTwice: [{ accountIds: ['a1', 'b1'], reason: 'same-name' }],
};

const MINE = {
  viewerId: 'bob',
  household: { householdId: 'h1', name: 'Home', role: 'member', baseCurrencyId: 'usd' },
  members: [
    { userId: 'alice', name: 'Alice', role: 'admin', joinedAt: '2026-09-01T00:00:00.000Z' },
    { userId: 'bob', name: 'Bob', role: 'member', joinedAt: '2026-09-02T00:00:00.000Z' },
    { userId: 'cara', name: 'Cara', role: 'member', joinedAt: '2026-09-03T00:00:00.000Z' },
  ],
  invites: [{ id: 'i1', email: 'dan@example.com', expiresAt: '2026-12-01T00:00:00.000Z' }],
  sharedAccountIds: ['b1'],
};

function respond(path: string, input: unknown): unknown {
  calls.push({ path, input });
  if (!member && path.startsWith('household.')) return NOT_FOUND;
  if (path === 'household.view') return VIEW;
  if (path === 'household.mine') return MINE;
  if (path === 'household.history') {
    if (unmeasuredOnly) {
      return { baseCurrencyId: 'usd', series: [], unmeasuredDates: ['2026-09-01', '2026-09-02'] };
    }
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
  unmeasuredOnly = false;
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

  test('labels every account with its owner and bank, and the viewer’s own as theirs', async () => {
    await mount();
    // The list's row on a phone, the table's on a wide screen: either names both.
    const row = (name: string) =>
      [...document.querySelectorAll('tr, li')].find((el) => el.textContent?.startsWith(name))
        ?.textContent ?? '';
    expect(row('Joint')).toContain('Alice');
    expect(row('Joint')).toContain('Bank');
    expect(row('joint')).toContain('You');
    expect(row('joint')).toContain('Bank');
  });

  test('lists who is in the household, what each shares, and marks the viewer (SC-1712)', async () => {
    await mount();
    const members = document.querySelector('section[aria-labelledby="household-members-heading"]');
    const rows = (members?.textContent ?? '').replace(/\s+/g, ' ');
    expect(rows).toContain('Alice');
    expect(rows).toContain('Admin · shares 1 account');
    expect(rows).toContain('Bob (you)');
    expect(rows).toContain('Cara');
    expect(rows).toContain('Member · shares nothing yet');
    expect(rows.indexOf('Alice')).toBeLessThan(rows.indexOf('Bob (you)'));
  });

  test('shows a pending invite as invited, beside the members', async () => {
    await mount();
    const members = document.querySelector('section[aria-labelledby="household-members-heading"]');
    expect(members?.textContent).toContain('dan@example.com');
    expect(members?.textContent).toContain('Invited');
  });

  test('links to Settings to manage members', async () => {
    await mount();
    const manage = [...document.querySelectorAll('a')].find((a) => a.textContent === 'Manage');
    expect(manage?.getAttribute('href')).toBe('/settings/data');
  });

  test('tells a non-member they are not in a household, at once, and points to Settings', async () => {
    member = false;
    await mount({ retries: true });

    expect(text()).toContain('You are not in a household');
    expect(text()).not.toContain('could not be loaded');
    const link = [...document.querySelectorAll('a')].find((a) =>
      a.textContent?.includes('Settings')
    );
    expect(link?.getAttribute('href')).toBe('/settings/data');
    expect(calls.filter((call) => call.path === 'household.view')).toHaveLength(1);
  });

  // SC-1712. A day a shared account was never valued is unmeasured; with no
  // measured day there is no household line to draw, so no chart at all.
  test('draws the household chart only when some day was measured', async () => {
    const chart = () =>
      document.querySelector('[aria-label="Household net worth over the last year"]');
    await mount();
    expect(chart()).not.toBeNull();
    await act(async () => root?.unmount());
    document.body.innerHTML = '';

    unmeasuredOnly = true;
    await mount();
    expect(text()).toContain('In USD');
    expect(chart()).toBeNull();
  });

  test('says when two members track the same account', async () => {
    await mount();
    expect(text()).toContain('Both of you track Joint: un-share one copy');
  });
});

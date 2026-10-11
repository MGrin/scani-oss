import { afterEach, describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import {
  BudgetAppImportResult,
  BudgetAppUndoResult,
} from '@/v3/components/jobs/BudgetAppImportResult';

/**
 * An import finishes inside the 30-second staleTime, so the import page's list
 * and targets were served from cache when the result's own link led back to it:
 * the new upload was missing and could not be undone until a reload (SC-1649).
 */

const LIST_KEY = [['budgetAppImports', 'list'], { type: 'query' }];
const TARGETS_KEY = [['budgetAppImports', 'targets'], { type: 'query' }];

let root: Root | null = null;
const realFetch = globalThis.fetch;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  globalThis.fetch = realFetch;
});

async function mountWithCachedPage(element: React.ReactElement): Promise<QueryClient> {
  globalThis.fetch = (async () => new Response('[]', { status: 200 })) as unknown as typeof fetch;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  client.setQueryData(LIST_KEY, []);
  client.setQueryData(TARGETS_KEY, { accounts: [] });
  const trpcClient = trpc.createClient({ links: [httpBatchLink({ url: 'http://api.test/trpc' })] });
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <trpc.Provider client={trpcClient} queryClient={client}>
        <QueryClientProvider client={client}>
          <MemoryRouter>{element}</MemoryRouter>
        </QueryClientProvider>
      </trpc.Provider>
    );
  });
  await act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return client;
}

const IMPORTED = {
  importId: 'u1',
  summary: {
    transfersPaired: 0,
    transfersUnpaired: 0,
    skippedRows: [],
    accounts: [
      { accountId: 'a1', name: 'Checking', created: true, rowsInserted: 5, rowsUpdated: 0 },
    ],
  },
};

describe('a finished budget-app job refreshes the import page it links back to', () => {
  test('the import result marks the cached list and targets stale', async () => {
    const client = await mountWithCachedPage(<BudgetAppImportResult result={IMPORTED} />);
    expect(document.body.textContent).toContain('Checking');
    expect(client.getQueryState(LIST_KEY)?.isInvalidated).toBe(true);
    expect(client.getQueryState(TARGETS_KEY)?.isInvalidated).toBe(true);
  });

  test('the undo result marks them stale too', async () => {
    const client = await mountWithCachedPage(
      <BudgetAppUndoResult result={{ rowsRemoved: 5, accountsRemoved: 2, accountsKept: 0 }} />
    );
    expect(client.getQueryState(LIST_KEY)?.isInvalidated).toBe(true);
    expect(client.getQueryState(TARGETS_KEY)?.isInvalidated).toBe(true);
  });

  test('control: an unreadable result leaves the cache alone', async () => {
    const client = await mountWithCachedPage(<BudgetAppImportResult result={null} />);
    expect(client.getQueryState(LIST_KEY)?.isInvalidated).toBe(false);
  });
});

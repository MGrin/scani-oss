import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import { getQueryKey } from '@trpc/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { trpc } from '../../../src/lib/trpc';
import { AccountField } from '../../../src/v3/components/capture/AccountField';
import en from '../../../src/v3/i18n/locales/en.json';
import type { PickMode } from '../../../src/v3/lib/manual-entry';

/**
 * SC-1249. A newcomer typing in a first holding was asked to "Search your
 * accounts…" and, once adding one, offered "Pick an existing account" — both
 * about a list that cannot exist yet.
 *
 * Rendered for real with the accounts answer seeded into the query cache. SSR
 * runs no fetch, so an unseeded query is `isSuccess: false`, which is exactly
 * the state that must NOT read as "none": a slow answer is not an empty one.
 */

const copy = en.v3.capture.account;

function render(mode: PickMode, accounts: { id: string; name: string }[] | undefined): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  if (accounts) {
    client.setQueryData(
      getQueryKey(trpc.accounts.getAll, undefined, 'query'),
      accounts.map((a) => ({ ...a, institutionId: 'inst-1' }))
    );
  }
  const trpcClient = trpc.createClient({
    links: [httpBatchLink({ url: 'http://localhost/trpc' })],
  });
  return renderToStaticMarkup(
    <trpc.Provider client={trpcClient} queryClient={client}>
      <QueryClientProvider client={client}>
        <AccountField
          mode={mode}
          value=""
          draft={{ name: '', typeId: '' }}
          institutionId=""
          institutionIsNew={false}
          onModeChange={() => {}}
          onSelect={() => {}}
          onDraftChange={() => {}}
        />
      </QueryClientProvider>
    </trpc.Provider>
  );
}

describe('the account field for someone with no accounts', () => {
  test('asks for a first account instead of offering a search', () => {
    const markup = render('existing', []);
    expect(markup).toContain(copy.firstPlaceholder);
    expect(markup).not.toContain(copy.searchPlaceholder);
  });

  test('offers no way back to a list that does not exist', () => {
    const markup = render('new', []);
    expect(markup).not.toContain(copy.pickExisting);
    // Control: the new-account form rendered, so the absence is a reading.
    expect(markup).toContain(copy.namePlaceholder);
  });

  test('someone with accounts still searches them and can go back', () => {
    const accounts = [{ id: 'a1', name: 'Brokerage' }];
    expect(render('existing', accounts)).toContain(copy.searchPlaceholder);
    expect(render('new', accounts)).toContain(copy.pickExisting);
  });

  test('an answer that has not arrived is not read as none', () => {
    const existing = render('existing', undefined);
    expect(existing).toContain(copy.searchPlaceholder);
    expect(existing).not.toContain(copy.firstPlaceholder);
    expect(render('new', undefined)).toContain(copy.pickExisting);
  });
});

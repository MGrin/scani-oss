import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import type { DisposalLotMatchDto, RealizedLedger as RealizedLedgerDto } from '@scani/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import { getQueryKey } from '@trpc/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { trpc } from '../../../src/lib/trpc';
import { RealizedLedger } from '../../../src/v3/components/holdings/RealizedLedger';

/**
 * The ledger's provenance line, on the screen (SC-324).
 *
 * `tests/v3/lib/realized-ledger.test.ts` pins the copy and the grouping without
 * a DOM, which is the right place for both — and it is exactly the coverage
 * instance 13 of `docs/technical/2026-08-15_absence-and-refusal.md` describes:
 * a distinction computed correctly, carried faithfully, and never rendered. A
 * function returning the right string proves nothing about what the reader
 * sees. This renders the component and looks.
 *
 * The query is answered from the cache rather than the network — SSR runs no
 * effects, so a pending query renders the whole section away and the assertion
 * would pass against an empty string.
 */
const HOLDING_ID = '11111111-1111-4111-8111-111111111111';

function lot(over: Partial<DisposalLotMatchDto> = {}): DisposalLotMatchDto {
  return {
    transactionId: '22222222-2222-4222-8222-222222222222',
    holdingId: HOLDING_ID,
    tokenId: 'token-eth',
    kind: 'withdraw',
    disposedAt: '2026-05-01T00:00:00.000Z',
    acquiredAt: '2025-01-01T00:00:00.000Z',
    quantity: '2',
    proceeds: '4000',
    costBasis: '3000',
    gain: '1000',
    holdingDays: 120,
    portionIndex: 0,
    portionCount: 1,
    basisQuality: 'known',
    outcome: 'realized',
    valuationBasis: 'execution_rate',
    answerSource: 'unattributed',
    ...over,
  };
}

function render(rows: DisposalLotMatchDto[]): string {
  const data: RealizedLedgerDto = {
    holdingId: HOLDING_ID,
    baseCurrencyId: 'token-USD',
    rows,
    realizedTotal: '1000',
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(
    getQueryKey(trpc.holdings.realizedLedger, { holdingId: HOLDING_ID }, 'query'),
    data
  );
  const trpcClient = trpc.createClient({
    links: [httpBatchLink({ url: 'http://localhost/trpc' })],
  });
  return renderToStaticMarkup(
    <StaticRouter location="/holdings">
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <RealizedLedger holdingId={HOLDING_ID} currency="USD" symbol="ETH" />
        </QueryClientProvider>
      </trpc.Provider>
    </StaticRouter>
  );
}

describe('RealizedLedger provenance', () => {
  test('a booked gain nobody is recorded as choosing is marked on the row', () => {
    const html = render([lot()]);

    // The gain is still shown — this change books nothing differently.
    expect(html).toContain('1,000');
    // And it no longer passes for a decision the reader made.
    expect(html).toContain('Answer not recorded');
    expect(html).toContain('no record of anyone answering it');
  });

  test('an answer the reader gave carries no caveat', () => {
    const html = render([lot({ answerSource: 'user' })]);

    expect(html).toContain('1,000');
    expect(html).not.toContain('Answer not recorded');
    expect(html).not.toContain('no record of anyone answering it');
  });

  test('a swap valued from the token that left says so on the row (SC-397)', () => {
    // The defect this guards against is the whole reason SC-397 has a visible
    // half: the row's arithmetic is now right, and a right number that does
    // not say where it came from is the same silence the 0.00 had. Rendered,
    // not just returned — a function producing the string proves nothing.
    const html = render([
      lot({ kind: 'swap_out', valuationBasis: 'held_token', answerSource: 'none' }),
    ]);

    expect(html).toContain('Swapped');
    expect(html).toContain('Valued from the token that left');
    expect(html).toContain('no price history');
  });

  test('a swap priced from its counter leg carries no valuation caveat', () => {
    // The ordinary case, and it is nearly every swap leg in production. A
    // caveat on those would be a caveat the reader learns to skip.
    const html = render([
      lot({ kind: 'swap_out', valuationBasis: 'execution_rate', answerSource: 'none' }),
    ]);

    expect(html).toContain('Swapped');
    expect(html).not.toContain('Valued from the token that left');
  });

  test('a swap leg carrying a stale answer says nothing about who answered (SC-402)', () => {
    // The row SC-398's import is waiting on. A `swap_out` that still carries a
    // `left_control` answered while it was a `transfer_out` arrives here
    // stamped `unattributed` unless something gates on kind — and the ledger
    // then told the reader *"Recorded as having left your portfolio, so this
    // gain was booked. There is no record of anyone answering it."* about a
    // DEX swap, where the gain was booked because it IS a swap and no answer
    // is owed.
    //
    // Rendered rather than asserted on `outcomeNote`, because that is where
    // the sentence exists: the badge and the paragraph were two conditions
    // written in two places, and a unit test on either one can pass while the
    // other prints (SC-235).
    const html = render([
      lot({
        kind: 'swap_out',
        valuationBasis: 'held_token',
        answerSource: 'unattributed',
      }),
    ]);

    // The gain is untouched — this books nothing differently.
    expect(html).toContain('1,000');
    expect(html).toContain('Swapped');

    // Neither half of the false sentence, and not the chip that summarises it.
    expect(html).not.toContain('Answer not recorded');
    expect(html).not.toContain('no record of anyone answering it');
    expect(html).not.toContain('left your portfolio');

    // And the caveat that IS true about this row still prints. The two used to
    // stack — a paragraph denying anyone answered directly above one saying
    // which price was used, about the same number.
    expect(html).toContain('Valued from the token that left');
  });

  test('a withdrawal with the same stale-looking answer still carries the caveat', () => {
    // The gate is on the question, not a blanket silence. `withdraw` is the
    // kind the queue asks about, so SC-324's sentence must survive intact —
    // a few hundred rows in production, and the realized PnL they carry, rest
    // on it.
    const html = render([lot({ kind: 'withdraw', answerSource: 'unattributed' })]);

    expect(html).toContain('Answer not recorded');
    expect(html).toContain('no record of anyone answering it');
  });

  test('a sale is not described as an unanswered transfer', () => {
    // `none` is the common case — nobody was asked about a sale, so there is
    // nothing to caveat and a chip on every row would mean nothing anywhere.
    const html = render([lot({ kind: 'sell', answerSource: 'none' })]);

    expect(html).toContain('Sold');
    expect(html).not.toContain('Answer not recorded');
  });
});

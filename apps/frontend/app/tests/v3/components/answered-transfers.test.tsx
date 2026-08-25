import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import type { AnsweredTransferReview } from '@scani/shared';
import { SETTLED_QUERY_STATE } from '@scani/ui/v3/lib/query-state';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { AnsweredTransferList } from '../../../src/v3/components/review/AnsweredTransferList';

/**
 * The answered list, and the one thing it must never say (SC-241).
 *
 * Same harness as `documents.test.tsx`: `renderToStaticMarkup` has no `window`,
 * so `useIsDesktop()` resolves false, and `StaticRouter` is required because
 * `V3DataView` reads the location. The list itself touches no tRPC hook — the
 * query lives on `AnsweredTransfersPage` and the mutation inside the peek,
 * which is what keeps this assertable without a client.
 *
 * The fixture is deliberately mixed. 573 of one user's 579 answered rows carry
 * an answer no person gave, and a fixture of only stamped rows would render
 * identically before and after this change — the same trap that let five
 * number-rendering defects ship behind pre-rounded fixtures.
 */
function render(node: React.ReactNode, path = '/review/answered'): string {
  return renderToStaticMarkup(<StaticRouter location={path}>{node}</StaticRouter>);
}

const answered = (over: Partial<AnsweredTransferReview>): AnsweredTransferReview => ({
  transactionId: '11111111-1111-4111-8111-111111111111',
  holdingId: '22222222-2222-4222-8222-222222222222',
  tokenSymbol: 'USD',
  accountName: 'Airwallex',
  institutionName: 'Airwallex',
  kind: 'withdraw',
  quantity: '4000',
  occurredAt: '2026-05-17T09:00:00.000Z',
  counterparty: null,
  decision: 'left_control',
  split: null,
  reviewedAt: null,
  answerSource: 'unattributed',
  ruleNote: null,
  declared: false,
  createdDestination: false,
  ...over,
});

const ROWS: AnsweredTransferReview[] = [
  answered({
    transactionId: '33333333-3333-4333-8333-333333333333',
    reviewedAt: '2026-08-15T02:27:01.000Z',
    answerSource: 'user',
  }),
  answered({}),
];

/** One `<li>` per row, in the order given. */
function rows(html: string): string[] {
  return html.split('<li>').slice(1);
}

describe('AnsweredTransferList', () => {
  test('flags a row nobody is recorded as answering', () => {
    const [answeredByUser, unattributed] = rows(
      render(<AnsweredTransferList items={ROWS} query={SETTLED_QUERY_STATE} onSearch={() => {}} />)
    );

    expect(unattributed).toContain('Not recorded');
    expect(answeredByUser).not.toContain('Not recorded');
  });

  test('the flag reaches a screen reader, not just the sighted row', () => {
    const [, unattributed] = rows(
      render(<AnsweredTransferList items={ROWS} query={SETTLED_QUERY_STATE} onSearch={() => {}} />)
    );

    expect(unattributed).toContain('aria-label="4000 USD, Airwallex · Airwallex');
    expect(unattributed?.split('aria-label="')[1]?.split('"')[0]).toContain('Not recorded');
  });

  test('an all-stamped list says "not recorded" about nothing', () => {
    const html = render(
      <AnsweredTransferList
        items={[ROWS[0] as AnsweredTransferReview]}
        query={SETTLED_QUERY_STATE}
        onSearch={() => {}}
      />
    );

    expect(html).not.toContain('Not recorded');
  });
});

/**
 * A row a RULE answered has to be legible as one (SC-380).
 *
 * The requirement mgrin set is that a rule-answered row be distinguishable from
 * one he answered — and specifically that the READ side show it, not merely
 * that the column store it. The failure this guards is the one the codebase has
 * already paid for twice: 560 rows answered by a write nobody could attribute,
 * four investigations, and no way to tell them from real answers on screen.
 *
 * The note is asserted alongside the provenance because "answered by a rule"
 * decays into exactly the same uselessness. His own sentence about 560 answered
 * transfers is *"I honestly can not remember that anymore anyway"*, and the
 * only durable thing about a 42-character destination is the words he wrote
 * next to it.
 */
describe('AnsweredTransferList — a rule answered it', () => {
  const RULE_ROWS: AnsweredTransferReview[] = [
    answered({
      transactionId: '44444444-4444-4444-8444-444444444444',
      reviewedAt: '2026-08-18T05:00:00.000Z',
      answerSource: 'rule',
      ruleNote: 'my Bybit deposit address',
    }),
    answered({
      transactionId: '55555555-5555-4555-8555-555555555555',
      reviewedAt: '2026-08-15T02:27:01.000Z',
      answerSource: 'user',
    }),
  ];

  test('says a rule answered it, and says which rule', () => {
    const [byRule, byUser] = rows(
      render(
        <AnsweredTransferList items={RULE_ROWS} query={SETTLED_QUERY_STATE} onSearch={() => {}} />
      )
    );

    expect(byRule).toContain('Answered by your rule: my Bybit deposit address');
    // Never "Not recorded": the provenance here is completely known, which is
    // the whole reason `rule` is its own source rather than an absent stamp.
    expect(byRule).not.toContain('Not recorded');
    expect(byUser).not.toContain('Answered by your rule');
  });

  test('the attribution reaches a screen reader too', () => {
    const [byRule] = rows(
      render(
        <AnsweredTransferList items={RULE_ROWS} query={SETTLED_QUERY_STATE} onSearch={() => {}} />
      )
    );

    expect(byRule?.split('aria-label="')[1]?.split('"')[0]).toContain('my Bybit deposit address');
  });

  test('a rule row with no rule left still says a rule answered it', () => {
    const html = render(
      <AnsweredTransferList
        items={[answered({ answerSource: 'rule', ruleNote: null })]}
        query={SETTLED_QUERY_STATE}
        onSearch={() => {}}
      />
    );

    expect(html).toContain('Answered by a rule you wrote about this destination');
  });
});

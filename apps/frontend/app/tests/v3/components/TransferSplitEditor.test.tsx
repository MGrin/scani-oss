import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import type { TransferDestination } from '@scani/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { TransferSplitEditor } from '../../../src/v3/components/review/TransferSplitEditor';
import type { SplitDraftRow } from '../../../src/v3/lib/transfer-review';

/**
 * The split editor as the two forms render it (SC-1665): the transfer review
 * divides a transaction, the balance-gap answer divides a change in a
 * balance, and two moves may not land on one holding.
 */

const ITEM = { transactionId: 'tx-1', quantity: '200', tokenSymbol: 'SOL' };

const destination = (accountId: string, accountName: string): TransferDestination => ({
  accountId,
  holdingId: `${accountId}-sol`,
  accountName,
  institutionName: 'Northwind',
  source: 'manual',
  balance: '100',
  movesBalance: true,
  relevance: 'holds_token',
});
const SAVINGS = destination('acc-savings', 'Savings');
const BROKERAGE = destination('acc-brokerage', 'Brokerage');

const row = (
  decision: SplitDraftRow['decision'],
  amount = '',
  dest: TransferDestination | null = null
): SplitDraftRow => ({
  decision,
  amount,
  matchTransactionId: null,
  destination: dest,
});

function render(rows: SplitDraftRow[], subject?: 'transfer' | 'change') {
  return renderToStaticMarkup(
    <TransferSplitEditor
      item={ITEM}
      rows={rows}
      onChange={() => {}}
      hasMatch={false}
      destinations={[SAVINGS, BROKERAGE]}
      destinationsLoading={false}
      subject={subject}
    />
  );
}

/** Each radio in the named group, as `account name: disabled?`. */
function radios(html: string, group: string): string[] {
  return [...html.matchAll(/<label[^>]*>\s*<input([^>]*)>([\s\S]*?)<\/label>/g)]
    .filter(([, attrs]) => attrs?.includes(`name="${group}"`))
    .map(([, attrs, body]) => {
      const name = /(Savings|Brokerage)/.exec(body ?? '')?.[1];
      return `${name}: ${attrs?.includes('disabled') ? 'disabled' : 'open'}`;
    });
}

describe('TransferSplitEditor', () => {
  test('the total names what it divides: a transfer, or a change in a balance', () => {
    expect(render([row('internal')])).toContain('Transfer was 200 SOL');
    const change = render([row('internal')], 'change');
    expect(change).toContain('Change was 200 SOL');
    expect(change).not.toContain('Transfer was');
  });

  test('the second move cannot pick the holding the first one took, and the first keeps it', () => {
    const html = render([
      row('internal', '150', SAVINGS),
      row('internal', '50', BROKERAGE),
      row('left_control'),
    ]);
    expect(radios(html, 'split-destination-tx-1-0')).toEqual([
      'Savings: open',
      'Brokerage: disabled',
    ]);
    expect(radios(html, 'split-destination-tx-1-1')).toEqual([
      'Savings: disabled',
      'Brokerage: open',
    ]);
  });

  test('the control: one move has every holding open', () => {
    const html = render([row('internal', '200', SAVINGS), row('left_control')]);
    expect(radios(html, 'split-destination-tx-1-0')).toEqual(['Savings: open', 'Brokerage: open']);
  });
});

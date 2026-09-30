import { describe, expect, test } from 'bun:test';
import { flowCoverageOf } from '../../../src/lib/returns/flow-coverage';

/**
 * SC-1427 — which holdings a return can count, and from when.
 *
 * Every row below is a shape a real `holding_coverage` row takes; the
 * quantities are synthetic.
 */
const reconciled = new Date('2026-09-29T00:00:00.000Z');
const row = (over: Partial<Parameters<typeof flowCoverageOf>[0]>) => ({
  hasCompleteTxHistory: false,
  unexplainedResidual: null,
  openingBalanceQuantity: null,
  txSources: ['etherscan'],
  firstTxAt: new Date('2026-09-01T11:58:13.000Z'),
  lastReconciledAt: reconciled,
  ...over,
});

describe('flowCoverageOf', () => {
  test('a claimed ledger is complete', () => {
    expect(flowCoverageOf(row({ hasCompleteTxHistory: true }))).toEqual({ kind: 'complete' });
  });

  test('no coverage row is not a ledger', () => {
    expect(flowCoverageOf(undefined)).toEqual({ kind: 'incomplete' });
  });

  test('a position simply held since its first reading counts from it (SC-1448)', () => {
    expect(flowCoverageOf(undefined, '2026-05-17')).toEqual({
      kind: 'from',
      from: '2026-05-17',
      heldBefore: true,
    });
  });

  test('a real ledger is not overridden by an unchanged reading', () => {
    expect(flowCoverageOf(row({ unexplainedResidual: '1500.25' }), '2026-05-17')).toEqual({
      kind: 'incomplete',
    });
  });

  // The operator's manual rule: the ledger starts with the acquisition (the
  // reconciler needed no opening) and no later observation contradicts it.
  // Base airdrops and hand-kept balances land here.
  test('a ledger that explains the first balance counts from its first transaction', () => {
    expect(flowCoverageOf(row({}))).toEqual({
      kind: 'from',
      from: '2026-09-01',
      heldBefore: false,
    });
    expect(flowCoverageOf(row({ txSources: [], openingBalanceQuantity: '0' }))).toEqual({
      kind: 'from',
      from: '2026-09-01',
      heldBefore: false,
    });
  });

  // IBKR: the Flex statement starts after the position was bought, so the
  // reconciler put the older shares in as a positive opening at the ledger's
  // start. The position is counted from there, and it was HELD before.
  test("a broker statement that starts after the purchase counts from the statement's first day", () => {
    expect(
      flowCoverageOf(
        row({
          txSources: ['ibkr-api'],
          openingBalanceQuantity: '10.5',
          firstTxAt: new Date('2025-10-31T09:30:00.999Z'),
        })
      )
    ).toEqual({ kind: 'from', from: '2025-10-31', heldBefore: true });
  });

  test('a positive opening with no ingester behind it stays out: a hand-kept balance is not a statement', () => {
    expect(flowCoverageOf(row({ txSources: [], openingBalanceQuantity: '1200' }))).toEqual({
      kind: 'incomplete',
    });
    expect(
      flowCoverageOf(
        row({ txSources: ['apy-payout', 'reconciliation-opening'], openingBalanceQuantity: '500' })
      )
    ).toEqual({ kind: 'incomplete' });
  });

  // Kraken and Airwallex: money arrived before the ledger's first row. A
  // missing inflow is a real gap, and the reason stays honest.
  test('missing inflows stay out', () => {
    expect(
      flowCoverageOf(row({ txSources: ['kraken-api'], openingBalanceQuantity: '-0.05' }))
    ).toEqual({ kind: 'incomplete' });
  });

  test('a balance the ledger cannot explain stays out', () => {
    expect(flowCoverageOf(row({ unexplainedResidual: '1500.25' }))).toEqual({ kind: 'incomplete' });
    expect(flowCoverageOf(row({ unexplainedResidual: '0' }))).toEqual({
      kind: 'from',
      from: '2026-09-01',
      heldBefore: false,
    });
  });

  test('an unreconciled or empty ledger stays out', () => {
    expect(flowCoverageOf(row({ lastReconciledAt: null }))).toEqual({ kind: 'incomplete' });
    expect(flowCoverageOf(row({ firstTxAt: null }))).toEqual({ kind: 'incomplete' });
  });
});

import { expect } from 'bun:test';
import { Container } from 'typedi';
import {
  type BalanceAtTimeResult,
  BalanceAtTimeService,
} from '../../src/services/pricing/BalanceAtTimeService';

/** One holding's balance at one instant, as every chart and rollup reads it. */
export interface HistoryReading {
  holdingId: string;
  at: Date;
  balance: string | null;
  anchor: BalanceAtTimeResult['anchor'];
}

export type HistorySnapshot = readonly HistoryReading[];

async function read(holdingId: string, at: Date): Promise<HistoryReading> {
  const { balance, anchor } = await Container.get(BalanceAtTimeService).getBalance(
    holdingId,
    at,
    undefined
  );
  return { holdingId, at, balance: balance?.toFixed() ?? null, anchor };
}

/** Every holding at every instant, holding-major. */
export function captureHistory(
  holdingIds: readonly string[],
  instants: readonly Date[]
): Promise<HistorySnapshot> {
  return Promise.all(holdingIds.flatMap((id) => instants.map((at) => read(id, at))));
}

/**
 * Re-reads every pair `before` holds and asserts its balance did not move.
 *
 * The anchor is printed and never compared: a writer that stops fabricating an
 * observation can move the anchor while every figure stays put, and the
 * figure is what a person sees.
 */
export async function expectHistoryUnchanged(before: HistorySnapshot): Promise<void> {
  const after = await Promise.all(before.map(({ holdingId, at }) => read(holdingId, at)));
  const moved = before.flatMap((was, i) => {
    const now = after[i]!;
    return now.balance === was.balance
      ? []
      : [
          `${was.holdingId} at ${was.at.toISOString()}: ${was.balance} (${was.anchor}) -> ${now.balance} (${now.anchor})`,
        ];
  });
  expect(moved).toEqual([]);
}

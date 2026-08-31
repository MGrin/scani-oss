/**
 * The HOURLY cron correcting a position the chain measures at zero, and
 * refusing to when the chain could not be read (SC-872).
 *
 * SC-852 shipped the probe and wired it to the manual Refresh button only. The
 * button is pressed on holdings somebody is already looking at; the position
 * that sits at a stale non-zero figure for months is by definition on a wallet
 * nobody opens. So the correction had to reach the unattended path, and the
 * decision to write the zero with no human in the loop was mgrin's, 2026-08-31.
 *
 * THAT DECISION IS ONLY SAFE WHILE THE THREE STATES STAY THREE. `exited` is a
 * balance that was READ and came back zero. `unreadable` is a provider that
 * failed, and `held` is a token discovery merely missed. Collapse the first
 * two and one Etherscan outage anchors every candidate on every wallet at
 * zero in a single run — and `holdings.balance` is an anchor rather than a
 * sum, so those zeros rewrite the reconstructed history behind them, with
 * nobody watching a cron to notice.
 *
 * SO EVERY TEST HERE IS A PAIR, exactly as the refresh path's is
 * (`RefreshAccountBalanceUseCase.exitProbe.test.ts`). A test asserting only
 * that the zero gets written passes for a two-state collapse, which is the
 * bug this ticket exists to avoid rather than the one it fixes.
 *
 * The three-way probe itself is tested against the explorer in
 * `@scani/providers` (`etherscan-position-probe.test.ts`), and the candidate
 * filtering in `ExitedPositionProbe` via the refresh path's file. What is
 * exercised here is what the CRON does with the answers, and the guard the
 * cron needs that the manual path does not.
 */

import { describe, expect, test } from 'bun:test';
import type { HoldingSnapshot, PositionProbe } from '@scani/providers/core/types';
import { Container } from 'typedi';
import { ExitedPositionProbe } from '../../src/services/holdings/ExitedPositionProbe';
import { SyncWalletBalancesUseCase } from '../../src/use-cases/SyncWalletBalancesUseCase';
import { restoreContainerAfterAll } from '../../test/helpers/container';

restoreContainerAfterAll();

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

const candidate = (externalId: string, symbol: string) => ({
  holding: { externalId, source: 'blockchain', isHidden: false, balance: '250.5' },
  token: {
    symbol,
    name: symbol,
    decimals: 6,
    iconUrl: null,
    marketSegment: null,
    providerMetadata: { etherscan: { chainId: 1, contractAddress: externalId } },
    isScamProbability: 0,
  },
});

const snapshot = (externalId: string, symbol: string): HoldingSnapshot => ({
  externalId,
  balance: '0.7497719',
  capturedAt: new Date('2026-08-31T03:01:00.000Z'),
  tokenIdentity: { symbol },
});

/**
 * Drives the cron's own probe step the way the refresh path's test drives
 * its equivalent: the wiring between the provider's answer and the snapshot
 * the sync persists is what is being tested, and it needs no database to be
 * wrong.
 */
async function probeForAccount(args: {
  /** Absent means the provider does not implement the capability at all. */
  answer?: (externalIds: readonly string[]) => Promise<PositionProbe[]>;
  snapshots?: HoldingSnapshot[];
  candidates?: ReturnType<typeof candidate>[];
  loadThrows?: boolean;
}) {
  Container.set(ExitedPositionProbe, new ExitedPositionProbe());
  const useCase = new SyncWalletBalancesUseCase();
  Container.set(SyncWalletBalancesUseCase, useCase);

  const asked: string[][] = [];
  let loadCalls = 0;
  const provider = args.answer
    ? {
        probePositions: async (_ctx: unknown, externalIds: readonly string[]) => {
          asked.push([...externalIds]);
          return args.answer?.(externalIds) ?? [];
        },
      }
    : {};

  const result = await (
    useCase as unknown as {
      probeExitsForAccount: (a: Record<string, unknown>) => Promise<{
        snapshots: HoldingSnapshot[];
        exitedSymbols: string[];
      }>;
    }
  ).probeExitsForAccount({
    provider,
    ctx: { institutionCode: 'ethereum' },
    snapshots: args.snapshots ?? [snapshot('native', 'ETH')],
    capturedAt: new Date('2026-08-31T12:00:00.000Z'),
    loadCandidates: async () => {
      loadCalls++;
      if (args.loadThrows) throw new Error('pool timeout');
      return args.candidates ?? [candidate(USDC, 'USDC')];
    },
  });
  return { ...result, asked, loadCalls };
}

const answerAll = (state: PositionProbe['state']) => async (ids: readonly string[]) =>
  ids.map((externalId) => ({ externalId, state }));

describe('the cron auto-zeroes only what was measured (SC-872)', () => {
  /**
   * THE CONTROL, and neither half proves anything alone. Assert only the
   * first and a cron that calls every absence an exit passes — that is the
   * silent-corruption bug. Assert only the second and today's behaviour, which
   * never writes the zero at all, passes.
   */
  test('a measured zero anchors the holding; an unreadable answer changes nothing', async () => {
    const exited = await probeForAccount({ answer: answerAll('exited') });
    const unreadable = await probeForAccount({ answer: answerAll('unreadable') });

    expect(exited.exitedSymbols).toEqual(['USDC']);
    expect(exited.snapshots).toHaveLength(1);
    expect(exited.snapshots[0]?.balance).toBe('0');
    expect(exited.snapshots[0]?.externalId).toBe(USDC);

    expect(unreadable.exitedSymbols).toEqual([]);
    expect(unreadable.snapshots).toEqual([]);

    // Same account, same candidate, same provider — a different answer has to
    // produce a different outcome, or the states have collapsed.
    expect(exited.snapshots).not.toEqual(unreadable.snapshots);
  });

  /**
   * The third answer, and it belongs with the transient one. A non-zero
   * balance means discovery missed a token that IS there — the 10k-page blind
   * spot `staleStrategy: 'preserve'` exists for — so the figure stands.
   */
  test('a token still held is left alone, exactly as an unreadable one is', async () => {
    const held = await probeForAccount({ answer: answerAll('held') });
    expect(held.snapshots).toEqual([]);
    expect(held.exitedSymbols).toEqual([]);
  });

  /**
   * The zero has to land on the holding it is about. The cron runs the wallet
   * path with `dedupStrategy: 'externalId'`, so a snapshot whose identity
   * resolves to a DIFFERENT token finds no existing row, writes nothing, and
   * leaves the stale figure up while `exitedSymbols` still reads correct.
   */
  test("the zero snapshot carries the existing token's identity", async () => {
    const { snapshots } = await probeForAccount({ answer: answerAll('exited') });
    expect(snapshots[0]?.tokenIdentity).toMatchObject({
      symbol: 'USDC',
      decimals: 6,
      providerMetadata: { etherscan: { chainId: 1, contractAddress: USDC } },
    });
  });
});

describe('what the cron refuses to spend, and refuses to write (SC-872)', () => {
  /**
   * The guard the unattended path needs and the manual one already has: a
   * provider that returned NOTHING is the outage shape, and the refresh path
   * refuses to zero on it for the same reason. Pairs with the control above —
   * the identical `exited` answer writes a zero when the fetch succeeded.
   */
  test('an empty fetch is an outage, so nothing is asked and nothing is written', async () => {
    const outage = await probeForAccount({ answer: answerAll('exited'), snapshots: [] });
    expect(outage.snapshots).toEqual([]);
    expect(outage.exitedSymbols).toEqual([]);
    expect(outage.asked).toEqual([]);
    // Refused before the candidates are even loaded — an account with nothing
    // to resolve must cost neither a query nor an upstream call.
    expect(outage.loadCalls).toBe(0);

    // MUST-BE-FOUND control: the same answer, on a fetch that worked, writes.
    const healthy = await probeForAccount({ answer: answerAll('exited') });
    expect(healthy.exitedSymbols).toEqual(['USDC']);
    expect(healthy.loadCalls).toBe(1);
  });

  test('a provider without the capability costs no query and does not throw', async () => {
    const { snapshots, exitedSymbols, loadCalls } = await probeForAccount({});
    expect(snapshots).toEqual([]);
    expect(exitedSymbols).toEqual([]);
    expect(loadCalls).toBe(0);
  });

  test('a throwing probe degrades to every absence unresolved', async () => {
    const { snapshots, exitedSymbols } = await probeForAccount({
      answer: async () => {
        throw new Error('etherscan 429');
      },
    });
    expect(snapshots).toEqual([]);
    expect(exitedSymbols).toEqual([]);
  });

  /**
   * The candidate read is a database call inside an hourly fan-out over every
   * user. It failing must cost the split and nothing else — the balances are
   * already fetched and are the answer the run came for.
   */
  test('a failing candidate load leaves the balances alone', async () => {
    const { snapshots, exitedSymbols, asked } = await probeForAccount({
      answer: answerAll('exited'),
      loadThrows: true,
    });
    expect(snapshots).toEqual([]);
    expect(exitedSymbols).toEqual([]);
    expect(asked).toEqual([]);
  });
});

/**
 * The refresh path telling a position that LEFT the wallet apart from one the
 * provider failed to reach (SC-852).
 *
 * Both arrive as the same thing: a holding whose token is absent from
 * `fetchBalances`. Until this existed the refresh called both "missing" and
 * told the user "USDC wasn't returned by the provider — try again in a minute",
 * which is right for one cause and impossible for the other, because a
 * departed token is never non-zero again. A reader who follows that advice
 * follows it forever, while the dashboard keeps counting a position the chain
 * reports as `0x0`.
 *
 * SO EVERY TEST HERE IS A PAIR, OR IT IS WORTHLESS. The two causes must
 * produce DIFFERENT outcomes from the SAME holding; a test asserting only that
 * the error went away passes equally for a use case that calls every absence
 * an exit, which anchors a holding at a zero nobody read — the same bug
 * pointing the other way. `holdings.balance` is an anchor rather than a sum,
 * so that zero rewrites the reconstructed history behind it.
 *
 * The three-way probe itself is tested against the explorer in
 * `@scani/providers` (`etherscan-position-probe.test.ts`). What is exercised
 * here is which rows get asked about at all, and what a `'0'` snapshot has to
 * carry to land on the holding it is about.
 */

import { describe, expect, test } from 'bun:test';
import type { HoldingSnapshot, PositionProbe } from '@scani/providers/core/types';
import { Container } from 'typedi';
import { RefreshAccountBalanceUseCase } from '../../src/use-cases/RefreshAccountBalanceUseCase';
import { restoreContainerAfterAll } from '../../test/helpers/container';

restoreContainerAfterAll();

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

interface Row {
  externalId: string | null;
  symbol: string;
  balance?: string;
  source?: string;
  isHidden?: boolean;
  scam?: number;
}

function candidate(row: Row) {
  return {
    holding: {
      externalId: row.externalId,
      source: row.source ?? 'blockchain',
      isHidden: row.isHidden ?? false,
      balance: row.balance ?? '250.5',
    },
    token: {
      symbol: row.symbol,
      name: row.symbol,
      decimals: 6,
      iconUrl: null,
      marketSegment: null,
      providerMetadata: { etherscan: { chainId: 1, contractAddress: row.externalId ?? '' } },
      isScamProbability: row.scam ?? 0,
    },
  };
}

const snapshot = (externalId: string, symbol: string): HoldingSnapshot => ({
  externalId,
  balance: '0.7497719',
  capturedAt: new Date('2026-08-29T03:01:00.000Z'),
  tokenIdentity: { symbol },
});

/**
 * Drives the private method the way `ImportWalletAddressUseCase.exitedPositions`
 * drives its own — the wiring between the provider and the snapshot is what is
 * being tested, and it needs no database to be wrong.
 */
async function probeExits(args: {
  holdings: Row[];
  snapshots?: HoldingSnapshot[];
  /** Absent means the provider does not implement the capability at all. */
  answer?: (externalIds: readonly string[]) => Promise<PositionProbe[]>;
}) {
  const useCase = new RefreshAccountBalanceUseCase();
  Container.set(RefreshAccountBalanceUseCase, useCase);

  const asked: string[][] = [];
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
      probeExitedPositions: (a: Record<string, unknown>) => Promise<{
        snapshots: HoldingSnapshot[];
        exitedSymbols: string[];
      }>;
    }
  ).probeExitedPositions({
    provider,
    ctx: { institutionCode: 'ethereum' },
    holdings: args.holdings.map(candidate),
    snapshots: args.snapshots ?? [snapshot('native', 'ETH')],
    capturedAt: new Date('2026-08-29T12:00:00.000Z'),
  });
  return { ...result, asked };
}

const answerAll = (state: PositionProbe['state']) => async (ids: readonly string[]) =>
  ids.map((externalId) => ({ externalId, state }));

describe('probeExitedPositions — the two causes must diverge (SC-852)', () => {
  /**
   * THE CONTROL. One holding, one absence, two answers from the probe, and the
   * outcomes have to differ. Neither half proves anything alone: assert only
   * the first and a use case that treats every absence as an exit passes;
   * assert only the second and today's broken behaviour passes.
   */
  test('a measured zero corrects the holding; an unreadable answer changes nothing', async () => {
    const holdings = [{ externalId: USDC, symbol: 'USDC' }];

    const exited = await probeExits({ holdings, answer: answerAll('exited') });
    const unreadable = await probeExits({ holdings, answer: answerAll('unreadable') });

    expect(exited.exitedSymbols).toEqual(['USDC']);
    expect(exited.snapshots).toHaveLength(1);
    expect(exited.snapshots[0]?.balance).toBe('0');
    expect(exited.snapshots[0]?.externalId).toBe(USDC);

    expect(unreadable.exitedSymbols).toEqual([]);
    expect(unreadable.snapshots).toEqual([]);

    // Same input, same provider, different answer, different outcome.
    expect(exited.snapshots).not.toEqual(unreadable.snapshots);
  });

  /**
   * The third answer, and it belongs with the transient one rather than the
   * exit. A non-zero balance means discovery missed a token that IS there —
   * the 10k-page blind spot `staleStrategy: 'preserve'` exists for — so the
   * old number stays on screen and "try again in a minute" is true advice.
   */
  test('a token still held is left alone, exactly as an unreadable one is', async () => {
    const holdings = [{ externalId: USDC, symbol: 'USDC' }];
    const held = await probeExits({ holdings, answer: answerAll('held') });
    expect(held.snapshots).toEqual([]);
    expect(held.exitedSymbols).toEqual([]);
  });

  /**
   * The zero has to land on the holding it is about. `HoldingsSyncHelper` runs
   * the wallet path with `dedupStrategy: 'externalId'` and `updateOnly: true`,
   * so a snapshot whose identity resolves to a DIFFERENT token finds no
   * existing row, writes nothing, and leaves the stale figure on the screen
   * while every assertion about `exitedSymbols` still passes. Carrying the
   * row's own token identity is what makes it match.
   */
  test("the zero snapshot carries the existing token's identity", async () => {
    const { snapshots } = await probeExits({
      holdings: [{ externalId: USDC, symbol: 'USDC' }],
      answer: answerAll('exited'),
    });
    expect(snapshots[0]?.tokenIdentity).toMatchObject({
      symbol: 'USDC',
      decimals: 6,
      providerMetadata: { etherscan: { chainId: 1, contractAddress: USDC } },
    });
  });
});

describe('probeExitedPositions — which rows are worth an upstream call (SC-852)', () => {
  /**
   * The budget claim, and it is not decoration: `OutflowRateLimiterRegistry`
   * keys one window with no per-service discriminator, so all four Fly
   * machines spend the same one. The population is "already stuck", not "every
   * holding on the account".
   */
  test('only the stuck rows are asked about', async () => {
    const { asked } = await probeExits({
      holdings: [
        { externalId: USDC, symbol: 'USDC' },
        // returned by the provider this run — nothing to resolve
        { externalId: WETH, symbol: 'WETH' },
        // the sync does not own it, so it must never touch it
        { externalId: '0xmanual', symbol: 'MANUAL', source: 'manual' },
        // already zero — the probe would confirm the number on screen
        { externalId: '0xclosed', symbol: 'CLOSED', balance: '0' },
        // no key to ask about
        { externalId: null, symbol: 'NOKEY' },
        // the user cannot see it, so no warning of theirs depends on it
        { externalId: '0xhidden', symbol: 'HIDDEN', isHidden: true },
        { externalId: '0xdust', symbol: 'DUST', scam: 0.9 },
      ],
      snapshots: [snapshot(WETH, 'WETH')],
      answer: answerAll('exited'),
    });
    expect(asked).toEqual([[USDC]]);
  });

  // MUST-BE-FOUND for the case above: without it, a method that asks about
  // nothing at all satisfies every exclusion in one go.
  test('a stuck row IS asked about when nothing excludes it', async () => {
    const { asked, exitedSymbols } = await probeExits({
      holdings: [{ externalId: USDC, symbol: 'USDC' }],
      answer: answerAll('exited'),
    });
    expect(asked).toEqual([[USDC]]);
    expect(exitedSymbols).toEqual(['USDC']);
  });

  test('a key that matches the snapshot in a different case is not re-asked', async () => {
    const { asked } = await probeExits({
      holdings: [{ externalId: USDC.toUpperCase(), symbol: 'USDC' }],
      snapshots: [snapshot(USDC, 'USDC')],
      answer: answerAll('exited'),
    });
    expect(asked).toEqual([]);
  });

  test('nothing stuck costs no upstream call', async () => {
    const { asked, snapshots } = await probeExits({
      holdings: [{ externalId: WETH, symbol: 'WETH' }],
      snapshots: [snapshot(WETH, 'WETH')],
      answer: answerAll('exited'),
    });
    expect(asked).toEqual([]);
    expect(snapshots).toEqual([]);
  });
});

describe('probeExitedPositions — what a failing probe costs (SC-852)', () => {
  /**
   * Today's behaviour, and the answer for every chain whose explorer cannot be
   * asked about one asset. It must not throw: the balances are the answer the
   * user pressed for and they are already in hand.
   */
  test('a provider without the capability resolves nothing and does not throw', async () => {
    expect(await probeExits({ holdings: [{ externalId: USDC, symbol: 'USDC' }] })).toMatchObject({
      snapshots: [],
      exitedSymbols: [],
    });
  });

  test('a throwing probe degrades to every absence unresolved', async () => {
    const { snapshots, exitedSymbols } = await probeExits({
      holdings: [{ externalId: USDC, symbol: 'USDC' }],
      answer: async () => {
        throw new Error('etherscan 429');
      },
    });
    expect(snapshots).toEqual([]);
    expect(exitedSymbols).toEqual([]);
  });

  /**
   * A probe result for a key nobody asked about cannot be trusted back into a
   * snapshot: the caller would anchor a holding this account may not own, and
   * there is no token identity to write it under.
   */
  test('an answer about a key nobody asked about is dropped', async () => {
    const { snapshots, exitedSymbols } = await probeExits({
      holdings: [{ externalId: USDC, symbol: 'USDC' }],
      answer: async () => [{ externalId: '0xsomethingelse', state: 'exited' as const }],
    });
    expect(snapshots).toEqual([]);
    expect(exitedSymbols).toEqual([]);
  });
});

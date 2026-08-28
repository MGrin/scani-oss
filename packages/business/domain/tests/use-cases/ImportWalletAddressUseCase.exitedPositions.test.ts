/**
 * The wiring between a provider that can name a wallet's closed positions and
 * the review card that offers them (SC-398).
 *
 * The rule is tested in `@scani/providers`, the subtraction in
 * `tests/use-cases/lib/exitedPositions.test.ts`. What is left is the part that
 * decides what happens when the provider CANNOT answer — three outcomes that
 * look alike from the outside and must not be collapsed:
 *
 *   no implementation   -> nothing offered, nothing said   (Bitcoin, TON, CEXs)
 *   a partial walk      -> what was found, plus a warning
 *   a failure           -> nothing offered, and SAID SO
 *
 * The last two are the ones worth pinning. Falling back silently to
 * balances-only is precisely the omission this ticket is about, and a reader
 * of the review card could not tell it from a wallet that never traded.
 */

import { describe, expect, test } from 'bun:test';
import type { ExitedPosition, HoldingSnapshot } from '@scani/providers/core/types';
import { Container } from 'typedi';
import { HoldingExclusionRepository } from '../../src/repositories/HoldingExclusionRepository';
import { ImportWalletAddressUseCase } from '../../src/use-cases/ImportWalletAddressUseCase';
import { restoreContainerAfterAll } from '../../test/helpers/container';

restoreContainerAfterAll();

type Errors = Array<{ chainId: string; chainName: string; error: string }>;

interface HistoryProvider {
  fetchExitedPositions?: (ctx: {
    noteWarning?: (reason: string) => void;
  }) => Promise<ExitedPosition[]>;
}

const HELD: HoldingSnapshot = {
  externalId: '0xusdc',
  balance: '5',
  capturedAt: new Date('2026-08-28T00:00:00.000Z'),
  tokenIdentity: { symbol: 'USDC' },
};

async function offer(
  historyProvider: HistoryProvider | undefined,
  options: { excludedKeys?: Set<string> } = {}
): Promise<{ snapshots: HoldingSnapshot[]; errors: Errors }> {
  Container.set(HoldingExclusionRepository, {
    findKeysByUser: async () => options.excludedKeys ?? new Set<string>(),
  });
  const useCase = new ImportWalletAddressUseCase();
  Container.set(ImportWalletAddressUseCase, useCase);

  const errors: Errors = [];
  const snapshots = await (
    useCase as unknown as {
      offerExitedPositions: (args: Record<string, unknown>) => Promise<HoldingSnapshot[]>;
    }
  ).offerExitedPositions({
    registry: { getTransactionsFetcher: () => historyProvider },
    institutionCode: 'ethereum',
    institutionId: 'eth',
    institutionName: 'Ethereum',
    chainKey: 'ethereum',
    ctx: { credentialsRef: { userId: 'u', institutionId: 'eth' } },
    userId: 'u',
    balances: [HELD],
    errors,
  });
  return { snapshots, errors };
}

describe('offerExitedPositions — what a failing history walk costs (SC-398)', () => {
  // MUST-BE-FOUND. Without this the two refusals below are equally satisfied
  // by a method that returns `[]` unconditionally.
  test('offers what the provider found', async () => {
    const { snapshots, errors } = await offer({
      fetchExitedPositions: async () => [
        { externalId: '0xgala', tokenIdentity: { symbol: 'GALA' } },
      ],
    });
    expect(snapshots.map((s) => s.externalId)).toEqual(['0xgala']);
    expect(snapshots[0]?.balance).toBe('0');
    expect(errors).toEqual([]);
  });

  // Today's behaviour for every chain with no authorisation signal — Bitcoin,
  // TON, and every exchange. It must stay SILENT: an error row here would put
  // a warning on the review card of every Bitcoin wallet ever imported, and
  // turn its outcome `partial` for a capability that was never claimed.
  test('a provider that cannot answer offers nothing and says nothing', async () => {
    expect(await offer({})).toEqual({ snapshots: [], errors: [] });
    expect(await offer(undefined)).toEqual({ snapshots: [], errors: [] });
  });

  // The failure that must not be silent. `errors` is what the card renders and
  // what makes the outcome `partial`, so this is the difference between "you
  // traded nothing" and "we could not check".
  test('a failed walk costs the offer and is reported, not swallowed', async () => {
    const { snapshots, errors } = await offer({
      fetchExitedPositions: async () => {
        throw new Error('etherscan 429');
      },
    });
    expect(snapshots).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain('etherscan 429');
    expect(errors[0]?.chainName).toBe('Ethereum');
  });

  // A truncated walk is a THIRD outcome: what was found is still worth
  // offering, and the shortfall is still worth saying.
  test('a partial walk offers what it found and warns as well', async () => {
    const { snapshots, errors } = await offer({
      fetchExitedPositions: async (ctx) => {
        ctx.noteWarning?.('pagination stopped early');
        return [{ externalId: '0xgala', tokenIdentity: { symbol: 'GALA' } }];
      },
    });
    expect(snapshots.map((s) => s.externalId)).toEqual(['0xgala']);
    expect(errors.map((e) => e.error)).toEqual(['pagination stopped early']);
  });

  // The exclusion gate is reached through this path, not only in the pure
  // function — a wiring that never loaded the keys would pass every test in
  // `exitedPositions.test.ts` and still re-offer a declined token.
  test('a token the user declined is not re-offered', async () => {
    const { snapshots } = await offer(
      {
        fetchExitedPositions: async () => [
          { externalId: '0xpunks', tokenIdentity: { symbol: 'PUNKS' } },
        ],
      },
      { excludedKeys: new Set(['eth:0xpunks']) }
    );
    expect(snapshots).toEqual([]);
  });
});

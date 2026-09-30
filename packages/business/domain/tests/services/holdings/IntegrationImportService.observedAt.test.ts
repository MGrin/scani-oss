process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { HoldingSnapshot } from '@scani/providers/core/types';
import { Container } from 'typedi';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingService } from '../../../src/services/holdings/HoldingService';
import { IntegrationImportService } from '../../../src/services/holdings/IntegrationImportService';
import { TokenService } from '../../../src/services/tokens/TokenService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

restoreContainerAfterAll();

// SC-1427: IBKR's connect and reconnect import writes balances through this
// service rather than HoldingsSyncHelper, so it has to carry the statement's
// as-of too, or a reconnect re-stamps every position at fetch time.
describe('IntegrationImportService — the observation is stamped at the source as-of', () => {
  test('passes each snapshot capturedAt to the update and the create', async () => {
    const seen: Array<{ kind: string; observedAt?: Date }> = [];
    Container.set(TokenService, {
      findOrCreateTokenFromIntegration: async (mapping: unknown) => ({
        token: {
          id: JSON.stringify(mapping).includes('"USD"') ? 'usd-token' : 'eur-token',
          symbol: 'X',
          name: 'X',
        },
        wasCreated: false,
      }),
    } as unknown as TokenService);
    Container.set(HoldingService, {
      updateHoldingBalanceWithEvent: async (input: { observedAt?: Date }) => {
        seen.push({ kind: 'update', observedAt: input.observedAt });
      },
      createHoldingWithEvent: async (input: { observedAt?: Date }) => {
        seen.push({ kind: 'create', observedAt: input.observedAt });
        return { id: 'new-id' };
      },
    } as unknown as HoldingService);
    Container.set(HoldingRepository, {
      findByAccountTokenAndExternalId: async (_a: string, tokenId: string) =>
        tokenId === 'usd-token'
          ? { id: 'usd-id', externalId: 'USD', isHidden: false, balance: '1' }
          : null,
    } as unknown as HoldingRepository);
    const service = new IntegrationImportService();

    // A query builder whose every chain resolves to the one account row.
    const account = { id: 'acct-1', name: 'IBKR', metadata: {} };
    const chain: unknown = new Proxy(() => chain, {
      get: (_t, prop) =>
        prop === 'then' ? (resolve: (v: unknown) => void) => resolve([account]) : () => chain,
      apply: () => chain,
    });

    const asOf = new Date('2026-08-14T20:00:00.000Z');
    const snapshot = (code: string, balance: string): HoldingSnapshot =>
      ({
        externalId: code,
        balance,
        capturedAt: asOf,
        tokenType: 'fiat',
        tokenIdentity: { symbol: code, name: code },
      }) as HoldingSnapshot;
    const result = { accounts: [], holdings: [], tokenIds: [], errors: [] };

    await (
      service as unknown as {
        processTarget: (...args: unknown[]) => Promise<void>;
      }
    ).processTarget(
      {
        accountInfo: { accountType: 'brokerage', externalId: 'U1' },
        institution: { id: 'inst-1', name: 'IBKR' },
        snapshots: [snapshot('USD', '10'), snapshot('EUR', '5')],
        preExistingAccountId: 'acct-1',
      },
      {
        userId: 'user-1',
        sourceTag: 'import_ibkr',
        arrival: 'auto_discovered',
        zeroStaleHoldings: false,
        resolveTokenTypeId: () => 'fiat-type',
        cryptoTokenTypeId: 'crypto-type',
        tokenTypeMap: { fiat: 'fiat-type' },
      },
      result,
      new Set<string>(),
      chain
    );

    expect(result.errors).toEqual([]);
    expect(seen).toEqual([
      { kind: 'update', observedAt: asOf },
      { kind: 'create', observedAt: asOf },
    ]);
  });
});

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { HoldingSnapshot } from '@scani/providers/core/types';
import { Container } from 'typedi';
import { TokenTypeRepository } from '../../../src/repositories/EnumRepositories';
import { FeedIngestService } from '../../../src/services/feeds/FeedIngestService';
import type { FeedBatch } from '../../../src/services/feeds/feed-batch';
import { IntegrationImportService } from '../../../src/services/holdings/IntegrationImportService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

restoreContainerAfterAll();

// SC-1427: IBKR's connect and reconnect import writes balances through this
// service rather than HoldingsSyncHelper, so it has to carry the statement's
// as-of too, or a reconnect re-stamps every position at fetch time. Since A2
// Task 15 the as-of reaches the observation as the batch checkpoint's instant,
// whether ingest then updates the holding or creates it
// (`IntegrationImportService.test.ts` reads both off the database).
describe('IntegrationImportService — the observation is stamped at the source as-of', () => {
  test("hands each snapshot's capturedAt to the batch as its checkpoint's instant", async () => {
    let sent: FeedBatch | undefined;
    Container.set(FeedIngestService, {
      ingest: async (batch: FeedBatch) => {
        sent = batch;
        return {
          checkpointOutcomes: batch.checkpoints.map(() => ({
            tokenId: null,
            holdingId: null,
            created: false,
            failure: null,
          })),
        };
      },
    } as unknown as FeedIngestService);
    Container.set(TokenTypeRepository, {
      findById: async () => ({ code: 'fiat' }),
    } as unknown as TokenTypeRepository);
    const service = new IntegrationImportService();

    // A query builder whose every chain resolves to the one account row, and
    // whose savepoint runs its callback on itself.
    const account = { id: 'acct-1', name: 'IBKR', metadata: {} };
    const chain: unknown = new Proxy(() => chain, {
      get: (_t, prop) =>
        prop === 'then'
          ? (resolve: (v: unknown) => void) => resolve([account])
          : prop === 'transaction'
            ? (run: (tx: unknown) => unknown) => run(chain)
            : () => chain,
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
    const errors: unknown[] = [];

    await (
      service as unknown as {
        processTarget: (...args: unknown[]) => Promise<unknown>;
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
      errors,
      chain
    );

    expect(errors).toEqual([]);
    expect(sent?.checkpoints.map((c) => [c.asset.identity.symbol, c.at])).toEqual([
      ['USD', asOf],
      ['EUR', asOf],
    ]);
  });
});

/**
 * `FeedIngestService.ingest`'s entry pipeline, the half a transaction import
 * moves onto (foundation A2 Task 10): provider identities through
 * `TokenIdentityService`, the find-only policy, swap groups by
 * `deterministicUuid(input, groupKey)` with the router's orphan rule, and
 * settle and fee legs linked to their trade inside the batch.
 *
 * Most tests run inside a rolled-back transaction. The last block commits,
 * because what it asserts is only visible across transactions: `updated_at` is
 * `now()`, which one transaction reads as a single instant, and whether a
 * provider is asked while the batch's own transaction is open.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { type DatabaseTransaction, getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import type { StatementIngesterResult } from '@scani/ingesters';
import { ProviderRegistry } from '@scani/providers/core/registry';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { FeedInputRepository } from '../../../src/repositories/FeedInputRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { deterministicUuid } from '../../../src/services/feeds/deterministic-id';
import {
  FeedBatchRejected,
  FeedIngestService,
} from '../../../src/services/feeds/FeedIngestService';
import type {
  AssetRef,
  FeedBatch,
  FeedEntry,
  LegacyBatchOptions,
  LegacyEntryColumns,
  TokenIdentity,
} from '../../../src/services/feeds/feed-batch';
import { LandingPlanner } from '../../../src/services/feeds/ingest/LandingPlanner';
import { legacyStatementBatch } from '../../../src/services/feeds/legacy/statement-batch';
import { TokenIdentityService } from '../../../src/services/tokens/TokenIdentityService';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../../test/helpers/factories-extra';
import { expectLabelsSettled } from '../../../test/helpers/labels-settled';
import { withLockWatch } from '../../../test/helpers/lock-watch';

const ingest = (batch: FeedBatch, tx?: DatabaseTransaction) =>
  Container.get(FeedIngestService).ingest(batch, tx);

const LONG_AGO = new Date('2026-01-01T00:00:00Z');
const EARLIER = new Date('2026-03-01T00:00:00Z');
const T1 = new Date('2026-07-01T10:00:00Z');
const FETCHED = new Date('2026-07-10T00:00:00Z');

const ORPHAN_NOTICE =
  'Recorded 1 swap leg(s) as plain transfers: the other side of the swap has no holding on this account, so nothing could be linked or priced.';
const skippedNotice = (events: number, tokens: number) =>
  `Skipped ${events} tx event(s) referencing ${tokens} token(s) the user didn't keep during wallet review.`;
const duplicatePlacementNotice = (events: number) =>
  `duplicate-placement: ${events} event(s) were placed on a holding that already held an older copy of them, while this feed recorded each on another holding. Each older copy was removed and the event moved to the holding it was placed on, so each is now held once.`;

/** A symbol no other test and no seed holds. */
const freshSymbol = () => `T${randomUUID().replace(/-/g, '').toUpperCase()}`;

function coin(symbol: string, identity: Partial<TokenIdentity> = {}): AssetRef {
  return { identity: { symbol, name: symbol, ...identity }, typeCode: 'crypto' };
}

function entry(
  asset: AssetRef,
  externalId: string,
  amount: string,
  legacy: Partial<LegacyEntryColumns> & Pick<LegacyEntryColumns, 'kind'>,
  more: Partial<FeedEntry> = {}
): FeedEntry {
  return {
    externalId,
    asset,
    amount,
    occurredAt: T1,
    legacy: { source: 'test-feed', sourceMetadata: {}, ...legacy },
    ...more,
  };
}

function txBatch(
  owner: { userId: string; accountId: string },
  holdingPolicy: LegacyBatchOptions['holdingPolicy'],
  entries: FeedEntry[],
  source = 'test-feed'
): FeedBatch {
  return {
    userId: owner.userId,
    input: { accountId: owner.accountId, source, credentialId: null, walletId: null },
    fetchedAt: FETCHED,
    window: { shape: 'transaction-run', from: T1, to: FETCHED, complete: false },
    checkpoints: [],
    entries: entries.map((e) => ({ ...e, legacy: { ...e.legacy, source } })),
    absences: [],
    legacy: {
      holdingMatch: 'ingest-order',
      holdingPolicy,
      holdingSource: 'ingest-backfill',
      arrival: null,
      writesCache: false,
      createdWithoutCheckpoint: 'zero',
      derivesTradeLegs: false,
      holdingFailure: 'skip-entry',
      absence: null,
      clearsAbsenceTally: false,
      createdCheckpointMeta: null,
      unchangedCheckpoint: 'append',
      zeroOpensHolding: true,
    },
    notices: [],
  };
}

async function owner(tx: DatabaseTransaction) {
  const userId = (await makeUser(tx)).id;
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId, institutionId: institution.id });
  return { userId, accountId: account.id, institutionId: institution.id };
}

const ledgerOf = (tx: DatabaseTransaction, userId: string) =>
  tx
    .select()
    .from(schema.holdingTransactions)
    .where(eq(schema.holdingTransactions.userId, userId))
    .orderBy(asc(schema.holdingTransactions.externalId));

const holdingsOf = (tx: DatabaseTransaction, accountId: string) =>
  tx
    .select()
    .from(schema.holdings)
    .where(eq(schema.holdings.accountId, accountId))
    .orderBy(asc(schema.holdings.createdAt), asc(schema.holdings.id));

const tokensWithSymbol = (tx: DatabaseTransaction, symbols: readonly string[]) =>
  tx
    .select()
    .from(schema.tokens)
    .where(inArray(schema.tokens.symbol, [...symbols]))
    .orderBy(asc(schema.tokens.marketSegment));

describe('FeedIngestService.ingest — swap groups and orphan legs', () => {
  // The half-swap, in both orders. A wallet resolves FIND-ONLY, so the leg into
  // a token the account holds nothing of is skipped, and the leg that remains
  // goes back to being the plain transfer it was (SC-332). Its counter and both
  // quotes name the skipped token; demotion nulls them, so none is created, in
  // either order (ruling R33).
  test('a swap whose other leg is skipped under find-only is demoted as today, in either order', async () => {
    await withTestDb(async (tx) => {
      const kept = await makeToken(tx, { symbol: freshSymbol() });
      const dropped = freshSymbol();

      const run = async (order: 'out-first' | 'in-first') => {
        const fixture = await owner(tx);
        const holding = await makeHolding(tx, {
          userId: fixture.userId,
          accountId: fixture.accountId,
          tokenId: kept.id,
          externalId: `${kept.symbol}-wallet`,
          kind: 'feed',
        });
        const out = entry(
          coin(kept.symbol),
          'swap-out',
          '-1',
          {
            kind: 'swap_out',
            counterQuantity: '2000',
            priceNative: '2000',
            counterPriceNative: '1',
            feeQuantity: '-0.01',
          },
          {
            groupKey: '1:swap',
            legacyAssets: {
              counter: coin(dropped),
              priceQuote: coin(dropped),
              counterPriceQuote: coin(dropped),
              fee: coin(kept.symbol),
            },
          }
        );
        const inn = entry(
          coin(dropped),
          'swap-in',
          '2000',
          { kind: 'swap_in', counterQuantity: '-1', priceNative: '0.0005' },
          {
            groupKey: '1:swap',
            legacyAssets: { counter: coin(kept.symbol), priceQuote: coin(kept.symbol) },
          }
        );
        const result = await ingest(
          txBatch(fixture, 'find-only', order === 'out-first' ? [out, inn] : [inn, out]),
          tx
        );
        const rows = (await ledgerOf(tx, fixture.userId)).map((r) => ({
          onKeptHolding: r.holdingId === holding.id,
          tokenId: r.tokenId,
          externalId: r.externalId,
          kind: r.kind,
          quantity: r.quantity,
          swapGroupId: r.swapGroupId,
          counterTokenId: r.counterTokenId,
          counterQuantity: r.counterQuantity,
          priceNative: r.priceNative,
          priceNativeTokenId: r.priceNativeTokenId,
          counterPriceNative: r.counterPriceNative,
          counterPriceNativeTokenId: r.counterPriceNativeTokenId,
          feeTokenId: r.feeTokenId,
          feeQuantity: r.feeQuantity,
          ledgerKind: r.ledgerKind,
        }));
        return {
          rows,
          notices: result.notices,
          droppedTokens: await tokensWithSymbol(tx, [dropped]),
          holdings: (await holdingsOf(tx, fixture.accountId)).map((h) => h.id),
          holdingId: holding.id,
        };
      };

      const outFirst = await run('out-first');
      const inFirst = await run('in-first');

      const expectedRow = {
        onKeptHolding: true,
        tokenId: kept.id,
        externalId: 'swap-out',
        kind: 'transfer_out',
        quantity: '-1',
        swapGroupId: null,
        counterTokenId: null,
        counterQuantity: null,
        priceNative: null,
        priceNativeTokenId: null,
        counterPriceNative: null,
        counterPriceNativeTokenId: null,
        feeTokenId: kept.id,
        feeQuantity: '-0.01',
        ledgerKind: 'transfer_out',
      };
      for (const reading of [outFirst, inFirst]) {
        expect(reading.rows).toEqual([expectedRow]);
        expect(reading.droppedTokens).toEqual([]);
        expect(reading.notices).toEqual([ORPHAN_NOTICE, skippedNotice(1, 1)]);
        expect(reading.holdings).toEqual([reading.holdingId]);
      }
    });
  });
});

describe('FeedIngestService.ingest — swap group ids', () => {
  test('one group key on two inputs gives two swap_group_ids', async () => {
    await withTestDb(async (tx) => {
      const [out, inn] = [
        await makeToken(tx, { symbol: freshSymbol() }),
        await makeToken(tx, { symbol: freshSymbol() }),
      ];
      const swap = [
        entry(coin(out.symbol), 'c-1', '-1', { kind: 'swap_out' }, { groupKey: 'conv' }),
        entry(coin(inn.symbol), 'c-2', '1', { kind: 'swap_in' }, { groupKey: 'conv' }),
      ];
      const groupsOf = async () => {
        const fixture = await owner(tx);
        const result = await ingest(txBatch(fixture, 'create', swap), tx);
        const ids = new Set((await ledgerOf(tx, fixture.userId)).map((r) => r.swapGroupId));
        return { ids: [...ids], expected: deterministicUuid(result.inputId, 'conv') };
      };

      const [first, second] = [await groupsOf(), await groupsOf()];

      expect(first.ids).toEqual([first.expected]);
      expect(second.ids).toEqual([second.expected]);
      expect(first.expected).not.toBe(second.expected);
    });
  });
});

describe('FeedIngestService.ingest — settlement legs', () => {
  test('a fee leg and a settle leg are linked to their parent inside the batch, and read fee / trade_leg with the right fee_of and group_id', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx);
      const stock = await makeToken(tx, { symbol: freshSymbol() });
      const cash = await makeToken(tx, { symbol: freshSymbol() });
      const settles = (parent: string) => ({ sourceMetadata: { settles: parent } });

      await ingest(
        txBatch(
          fixture,
          'create',
          [
            entry(
              coin(stock.symbol),
              't1',
              '2',
              { kind: 'buy', counterQuantity: '-1000', feeQuantity: '-1', priceNative: '500' },
              {
                legacyAssets: {
                  counter: coin(cash.symbol),
                  fee: coin(cash.symbol),
                  priceQuote: coin(cash.symbol),
                },
              }
            ),
            entry(
              coin(cash.symbol),
              't1:settle',
              '-1000',
              { kind: 'settle_out', ...settles('t1') },
              { settlesExternalId: 't1' }
            ),
            entry(
              coin(cash.symbol),
              't1:fee',
              '-1',
              { kind: 'fee', ...settles('t1') },
              { settlesExternalId: 't1' }
            ),
            // A fee in the row's own token, its own row on the same holding (SC-1486).
            entry(
              coin(cash.symbol),
              'k1',
              '-514.29',
              { kind: 'sell', feeQuantity: '-7.71' },
              { legacyAssets: { fee: coin(cash.symbol) } }
            ),
            entry(
              coin(cash.symbol),
              'k1:fee',
              '-7.71',
              { kind: 'fee', ...settles('k1') },
              { settlesExternalId: 'k1' }
            ),
          ],
          'bybit-api'
        ),
        tx
      );

      const rows = await ledgerOf(tx, fixture.userId);
      const idOf = (externalId: string) => rows.find((r) => r.externalId === externalId)!.id;
      expect(
        rows.map((r) => ({
          externalId: r.externalId,
          settlesTransactionId: r.settlesTransactionId,
          ledgerKind: r.ledgerKind,
          groupId: r.groupId,
          feeOf: r.feeOf,
          counterTokenId: r.counterTokenId,
          feeTokenId: r.feeTokenId,
          executionPriceTokenId: r.executionPriceTokenId,
        }))
      ).toEqual([
        {
          externalId: 'k1',
          settlesTransactionId: null,
          ledgerKind: 'trade_leg',
          groupId: idOf('k1'),
          feeOf: null,
          counterTokenId: null,
          feeTokenId: cash.id,
          executionPriceTokenId: null,
        },
        {
          externalId: 'k1:fee',
          settlesTransactionId: idOf('k1'),
          ledgerKind: 'fee',
          groupId: null,
          feeOf: idOf('k1'),
          counterTokenId: null,
          feeTokenId: null,
          executionPriceTokenId: null,
        },
        {
          externalId: 't1',
          settlesTransactionId: null,
          ledgerKind: 'trade_leg',
          groupId: idOf('t1'),
          feeOf: null,
          counterTokenId: cash.id,
          feeTokenId: cash.id,
          executionPriceTokenId: cash.id,
        },
        {
          externalId: 't1:fee',
          settlesTransactionId: idOf('t1'),
          ledgerKind: 'fee',
          groupId: null,
          feeOf: idOf('t1'),
          counterTokenId: null,
          feeTokenId: null,
          executionPriceTokenId: null,
        },
        {
          externalId: 't1:settle',
          settlesTransactionId: idOf('t1'),
          ledgerKind: 'trade_leg',
          groupId: idOf('t1'),
          feeOf: null,
          counterTokenId: null,
          feeTokenId: null,
          executionPriceTokenId: null,
        },
      ]);
    });
  });

  // One input states an external id once (Task 13), so two rows under one id
  // on two holdings cannot both be kept. Merging them would drop a ledger row
  // in silence, so the batch is refused before anything is read (R57). Before
  // the key both landed, and the leg was left for the settlement sweep.
  test('a batch naming one external id for two assets is refused, and writes nothing', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx);
      const [base, quote] = [
        await makeToken(tx, { symbol: freshSymbol() }),
        await makeToken(tx, { symbol: freshSymbol() }),
      ];

      const refused = await ingest(
        txBatch(
          fixture,
          'create',
          [
            entry(coin(base.symbol), 'x1', '1', { kind: 'buy' }),
            entry(coin(quote.symbol), 'x1', '-10', { kind: 'sell' }),
            entry(
              coin(base.symbol),
              'x1:fee',
              '-0.1',
              { kind: 'fee', sourceMetadata: { settles: 'x1' } },
              { settlesExternalId: 'x1' }
            ),
          ],
          'bybit-api'
        ),
        tx
      ).catch((error: unknown) => error);

      expect(refused).toBeInstanceOf(FeedBatchRejected);
      expect((refused as FeedBatchRejected).problems).toEqual([
        {
          code: 'duplicate-external-id',
          detail:
            '1 external id(s) are each sent for more than one asset or source, by 2 entries in all',
        },
      ]);
      expect(await ledgerOf(tx, fixture.userId)).toEqual([]);
      expect(await holdingsOf(tx, fixture.accountId)).toEqual([]);
      expect(
        await tx
          .select()
          .from(schema.feedInputs)
          .where(eq(schema.feedInputs.accountId, fixture.accountId))
      ).toEqual([]);
    });
  });

  // The control: the same event sent twice is a re-send, merged and reported
  // as it always was (SC-349).
  test('the same event sent twice in one batch is merged and reported, not refused', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx);
      const token = await makeToken(tx, { symbol: freshSymbol() });

      const result = await ingest(
        txBatch(fixture, 'create', [
          entry(coin(token.symbol), 'd1', '1', { kind: 'deposit' }),
          entry(coin(token.symbol), 'd1', '1', { kind: 'deposit' }),
        ]),
        tx
      );

      const rows = await ledgerOf(tx, fixture.userId);
      expect(rows.map((r) => r.externalId)).toEqual(['d1']);
      expect(result.merges).toEqual([
        { holdingId: rows[0]!.holdingId, source: 'test-feed', externalId: 'd1', dropped: 1 },
      ]);
    });
  });

  test('a leg whose trade is skipped is skipped with it, and only the trade is counted', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx);
      const cash = await makeToken(tx, { symbol: freshSymbol() });
      await makeHolding(tx, {
        userId: fixture.userId,
        accountId: fixture.accountId,
        tokenId: cash.id,
        externalId: `${cash.symbol}-wallet`,
      });
      const unknown = freshSymbol();

      const result = await ingest(
        txBatch(fixture, 'find-only', [
          entry(coin(unknown), 'p1', '5', { kind: 'buy', counterQuantity: '-10' }),
          entry(
            coin(cash.symbol),
            'p1:fee',
            '-1',
            { kind: 'fee', sourceMetadata: { settles: 'p1' } },
            { settlesExternalId: 'p1' }
          ),
        ]),
        tx
      );

      expect(await ledgerOf(tx, fixture.userId)).toEqual([]);
      expect(result.notices).toEqual([skippedNotice(1, 1)]);
    });
  });
});

describe('FeedIngestService.ingest — identities', () => {
  // `TokenIdentityService` decides what two mints with one symbol become;
  // ingest asks it once per identity and writes where it answers (ruling R31).
  // Since SC-1510 it resolves an SPL token by its mint, so the answers differ.
  test('two identities with one symbol and different mints each go to TokenIdentityService, and land on the token it gives them', async () => {
    const service = Container.get(TokenIdentityService);
    const original = service.findOrCreateByIdentity.bind(service);
    const answers = new Map<string, string>();
    const spy = spyOn(service, 'findOrCreateByIdentity').mockImplementation(
      async (partial, transaction) => {
        const token = await original(partial, transaction);
        const mint = (partial.providerMetadata as { solana?: { mint: string } }).solana?.mint;
        if (mint) answers.set(mint, token.id);
        return token;
      }
    );
    try {
      await withTestDb(async (tx) => {
        const fixture = await owner(tx);
        const symbol = freshSymbol();
        const mint = (id: string) => coin(symbol, { providerMetadata: { solana: { mint: id } } });

        await ingest(
          txBatch(fixture, 'create', [
            entry(mint('synthetic-mint-a'), 'm1', '5', { kind: 'deposit' }),
            entry(mint('synthetic-mint-b'), 'm2', '7', { kind: 'deposit' }),
          ]),
          tx
        );

        expect([...answers.keys()].sort()).toEqual(['synthetic-mint-a', 'synthetic-mint-b']);
        expect(answers.get('synthetic-mint-a')).not.toBe(answers.get('synthetic-mint-b'));
        const rows = await ledgerOf(tx, fixture.userId);
        expect(rows.map((r) => [r.externalId, r.tokenId])).toEqual([
          ['m1', answers.get('synthetic-mint-a')!],
          ['m2', answers.get('synthetic-mint-b')!],
        ]);
      });
    } finally {
      spy.mockRestore();
    }
  });

  test('two EVM tokens with one symbol and different contracts resolve to two tokens and two holdings', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx);
      const symbol = freshSymbol();
      const contract = (address: string) =>
        coin(symbol, { providerMetadata: { etherscan: { chainId: 1, contractAddress: address } } });

      await ingest(
        txBatch(fixture, 'create', [
          entry(contract('synthetic-contract-a'), 'c1', '5', { kind: 'deposit' }),
          entry(contract('synthetic-contract-b'), 'c2', '7', { kind: 'deposit' }),
          entry(contract('synthetic-contract-a'), 'c3', '1', { kind: 'deposit' }),
        ]),
        tx
      );

      const tokens = await tokensWithSymbol(tx, [symbol]);
      expect(tokens.map((t) => t.marketSegment)).toEqual([
        'evm:1:synthetic-contract-a',
        'evm:1:synthetic-contract-b',
      ]);
      const [a, b] = tokens;
      const holdings = await holdingsOf(tx, fixture.accountId);
      expect(holdings.map((h) => h.tokenId).sort()).toEqual([a!.id, b!.id].sort());
      const holdingOf = new Map(holdings.map((h) => [h.tokenId, h.id]));
      expect(
        (await ledgerOf(tx, fixture.userId)).map((r) => [r.externalId, r.tokenId, r.holdingId])
      ).toEqual([
        ['c1', a!.id, holdingOf.get(a!.id)!],
        ['c2', b!.id, holdingOf.get(b!.id)!],
        ['c3', a!.id, holdingOf.get(a!.id)!],
      ]);
    });
  });

  // A skipped event resolves none of its other tokens: they are priced
  // against, never held, and a token row nothing references is the whole cost
  // (SC-343, ruling R32).
  test('find-only skips an unknown primary asset and creates no token for it, and a surviving entry fee token is created on miss', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx);
      const held = await makeToken(tx, { symbol: freshSymbol() });
      const notHeld = await makeToken(tx, { symbol: freshSymbol() });
      await makeHolding(tx, {
        userId: fixture.userId,
        accountId: fixture.accountId,
        tokenId: held.id,
        externalId: `${held.symbol}-wallet`,
      });
      const [unknown, unknownFee, newFee] = [freshSymbol(), freshSymbol(), freshSymbol()];

      const result = await ingest(
        txBatch(fixture, 'find-only', [
          entry(
            coin(unknown),
            'u1',
            '100',
            { kind: 'transfer_in', feeQuantity: '-1' },
            { legacyAssets: { fee: coin(unknownFee) } }
          ),
          entry(coin(unknown), 'u2', '50', { kind: 'transfer_in' }),
          entry(coin(notHeld.symbol), 'n1', '3', { kind: 'transfer_in' }),
          entry(
            coin(held.symbol),
            'k1',
            '-1',
            { kind: 'transfer_out', feeQuantity: '-0.5' },
            { legacyAssets: { fee: coin(newFee) } }
          ),
        ]),
        tx
      );

      const created = await tokensWithSymbol(tx, [unknown, unknownFee, newFee]);
      expect(created.map((t) => t.symbol)).toEqual([newFee]);
      expect(
        (await ledgerOf(tx, fixture.userId)).map((r) => [r.externalId, r.tokenId, r.feeTokenId])
      ).toEqual([['k1', held.id, created[0]!.id]]);
      expect((await holdingsOf(tx, fixture.accountId)).map((h) => h.tokenId)).toEqual([held.id]);
      expect(result.skippedAssets.map((s) => s.symbol)).toEqual([unknown]);
      expect(result.notices).toEqual([skippedNotice(3, 2)]);
    });
  });

  // Ruling R36. The router counts an unknown token by its identity key, which
  // for anything but an EVM contract is `sym:SYMBOL:segment`: spam mints that
  // share a symbol are one token in that sentence, and stay one.
  test('find-only counts unknown tokens as the router does: mints sharing a symbol are one token, EVM contracts are each one', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx);
      const [spl, erc20] = [freshSymbol(), freshSymbol()];
      const mint = (id: string) => coin(spl, { providerMetadata: { solana: { mint: id } } });
      const contract = (address: string) =>
        coin(erc20, { providerMetadata: { etherscan: { chainId: 1, contractAddress: address } } });

      const result = await ingest(
        txBatch(fixture, 'find-only', [
          entry(mint('synthetic-mint-a'), 's1', '1', { kind: 'transfer_in' }),
          entry(mint('synthetic-mint-b'), 's2', '1', { kind: 'transfer_in' }),
          entry(mint('synthetic-mint-c'), 's3', '1', { kind: 'transfer_in' }),
          entry(contract('synthetic-contract-a'), 'e1', '1', { kind: 'transfer_in' }),
          entry(contract('synthetic-contract-b'), 'e2', '1', { kind: 'transfer_in' }),
        ]),
        tx
      );

      expect(result.notices).toEqual([skippedNotice(5, 3)]);
      expect(await ledgerOf(tx, fixture.userId)).toEqual([]);
    });
  });

  // Ruling R35. A lookup that fails is reported once per asset, however many
  // entries name it, and a database error inside it is rolled back to a
  // savepoint: without one, Postgres refuses every later statement in the
  // batch's transaction.
  test('an identity whose lookup fails is reported once, and a database error in it does not poison the batch', async () => {
    const service = Container.get(TokenIdentityService);
    const original = service.findOrCreateByIdentity.bind(service);
    const failing = new Set<string>();
    const spy = spyOn(service, 'findOrCreateByIdentity').mockImplementation(
      async (partial, transaction) => {
        if (partial.symbol && failing.has(partial.symbol)) {
          if (!transaction) throw new Error('expected a transaction');
          // Postgres now refuses every statement until a rollback.
          await transaction.execute(sql`select 1 / 0`).catch(() => undefined);
          throw new Error(`lookup of ${partial.symbol} failed`);
        }
        return await original(partial, transaction);
      }
    );
    try {
      await withTestDb(async (tx) => {
        const fixture = await owner(tx);
        const good = await makeToken(tx, { symbol: freshSymbol() });
        const [badPrimary, badFee] = [freshSymbol(), freshSymbol()];
        failing.add(badPrimary);
        failing.add(badFee);

        const result = await ingest(
          txBatch(fixture, 'create', [
            entry(coin(badPrimary), 'b1', '1', { kind: 'deposit' }),
            entry(coin(badPrimary), 'b2', '2', { kind: 'deposit' }),
            entry(
              coin(good.symbol),
              'g1',
              '-3',
              { kind: 'withdraw', feeQuantity: '-1' },
              { legacyAssets: { fee: coin(badFee) } }
            ),
          ]),
          tx
        );

        expect(
          (await ledgerOf(tx, fixture.userId)).map((r) => [r.externalId, r.tokenId, r.feeTokenId])
        ).toEqual([['g1', good.id, null]]);
        expect(result.skippedAssets).toEqual([
          { symbol: badPrimary, reason: `lookup of ${badPrimary} failed` },
        ]);
        expect(result.notices).toEqual([
          `Failed to resolve token identity ${badPrimary}: lookup of ${badPrimary} failed`,
          `Failed to resolve token identity ${badFee}: lookup of ${badFee} failed`,
        ]);
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('FeedIngestService.ingest — holdings by ingest order', () => {
  // `findForIngest`'s order (SC-193): a row the import created outranks one a
  // person keeps, then the oldest; a manual row is the fallback, and a feed
  // writing into it makes it feed (A1 K3, Review Focus 5).
  test('ingest-order prefers the row with an external_id, then the oldest, and falls back to the manual row, which becomes feed', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx);
      const [p, q, r] = [
        await makeToken(tx, { symbol: freshSymbol() }),
        await makeToken(tx, { symbol: freshSymbol() }),
        await makeToken(tx, { symbol: freshSymbol() }),
      ];
      const at = (tokenId: string, createdAt: Date, externalId: string | null) =>
        makeHolding(tx, {
          userId: fixture.userId,
          accountId: fixture.accountId,
          tokenId,
          externalId,
          createdAt,
          source: externalId === null ? 'manual' : 'import_test',
          kind: externalId === null ? 'snapshot' : 'feed',
        });
      await at(p.id, LONG_AGO, null);
      const pImported = await at(p.id, EARLIER, 'p-sync');
      await at(q.id, LONG_AGO, null);
      const qOldest = await at(q.id, EARLIER, 'q-1');
      await at(q.id, T1, 'q-2');
      const rManual = await at(r.id, LONG_AGO, null);
      const before = (await holdingsOf(tx, fixture.accountId)).length;

      const result = await ingest(
        txBatch(fixture, 'create', [
          entry(coin(p.symbol), 'p1', '1', { kind: 'deposit' }),
          entry(coin(q.symbol), 'q1', '1', { kind: 'deposit' }),
          entry(coin(r.symbol), 'r1', '1', { kind: 'deposit' }),
        ]),
        tx
      );

      expect(
        (await ledgerOf(tx, fixture.userId)).map((row) => [row.externalId, row.holdingId])
      ).toEqual([
        ['p1', pImported.id],
        ['q1', qOldest.id],
        ['r1', rManual.id],
      ]);
      expect(result.createdHoldingIds).toEqual([]);
      expect((await holdingsOf(tx, fixture.accountId)).length).toBe(before);
      const [manualAfter] = await tx
        .select()
        .from(schema.holdings)
        .where(eq(schema.holdings.id, rManual.id));
      expect(manualAfter?.kind).toBe('feed');
    });
  });
});

/**
 * The entry key (A2 D-7, Task 13): ingest arbitrates on (input_id,
 * external_id), so an event its input states again updates its one row,
 * wherever the import now places it.
 */
describe('FeedIngestService.ingest — the entry key (input, external_id)', () => {
  const coverageOf = async (tx: DatabaseTransaction, holdingId: string) => {
    const [row] = await tx
      .select()
      .from(schema.holdingCoverage)
      .where(eq(schema.holdingCoverage.holdingId, holdingId));
    return row ? [row.firstTxAt, row.lastTxAt] : null;
  };

  test('ingest moves a re-imported row to the holding it now resolves to instead of inserting a second', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx);
      const token = await makeToken(tx, { symbol: freshSymbol() });
      const batch = txBatch(fixture, 'create', [
        entry(coin(token.symbol), 'p1', '1', { kind: 'deposit' }),
      ]);
      const first = await ingest(batch, tx);
      const [created] = first.createdHoldingIds;
      // An imported row outranks the one ingest created (`findForIngest`).
      const imported = await makeHolding(tx, {
        userId: fixture.userId,
        accountId: fixture.accountId,
        tokenId: token.id,
        externalId: `${token.symbol}-sync`,
        kind: 'feed',
      });

      const second = await ingest(batch, tx);

      expect(
        (await ledgerOf(tx, fixture.userId)).map((r) => [
          r.externalId,
          r.holdingId,
          r.tokenId,
          r.inputId,
        ])
      ).toEqual([['p1', imported.id, token.id, first.inputId]]);
      expect(second.earliestChangedAt).toEqual(T1);
      // The holding it left summarizes a ledger with nothing in it now.
      expect(await coverageOf(tx, created!)).toEqual([null, null]);
      expect(await coverageOf(tx, imported.id)).toEqual([T1, T1]);
    });
  });

  test('a re-imported row whose asset now resolves to another token moves with its token', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx);
      const [was, now] = [
        await makeToken(tx, { symbol: freshSymbol() }),
        await makeToken(tx, { symbol: freshSymbol() }),
      ];
      await ingest(
        txBatch(fixture, 'create', [entry(coin(was.symbol), 'r1', '1', { kind: 'deposit' })]),
        tx
      );
      const second = await ingest(
        txBatch(fixture, 'create', [entry(coin(now.symbol), 'r1', '1', { kind: 'deposit' })]),
        tx
      );

      const [moved] = second.createdHoldingIds;
      expect(
        (await ledgerOf(tx, fixture.userId)).map((r) => [r.externalId, r.holdingId, r.tokenId])
      ).toEqual([['r1', moved!, now.id]]);
    });
  });

  test('a statement re-upload in another format with the same synthetic id updates instead of duplicating', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx);
      const currency = await makeToken(tx, { symbol: freshSymbol() });
      const externalId = 'synthetic:2026-07-01T10:00:00:-12.5:Coffee:1';
      const upload = (format: string, fetchedAt: Date) =>
        legacyStatementBatch({
          userId: fixture.userId,
          accountId: fixture.accountId,
          result: {
            format,
            bankTemplate: null,
            lines: [
              {
                currency: currency.symbol,
                rows: [
                  {
                    kind: 'withdraw',
                    quantity: '-12.5',
                    occurredAt: T1,
                    externalId,
                    source: `statement-${format}`,
                    counterparty: null,
                    sourceMetadata: { description: 'Coffee', format },
                    rawPayload: null,
                  },
                ],
              },
            ],
            closes: [],
            positions: [],
            warnings: [],
          } as StatementIngesterResult,
          uploadRef: `uploads/statement.${format}`,
          fetchedAt,
        });

      const first = await ingest(upload('csv', FETCHED), tx);
      await ingest(upload('xlsx', new Date(FETCHED.getTime() + 60_000)), tx);

      // The key does not take the source, so the row keeps the first upload's.
      expect(
        (await ledgerOf(tx, fixture.userId)).map((r) => [
          r.externalId,
          r.source,
          (r.sourceMetadata as { format?: string }).format,
          r.inputId,
        ])
      ).toEqual([[externalId, 'statement-csv', 'xlsx', first.inputId]]);
    });
  });

  test("a taken-over row carries the batch's input_id (R54)", async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx);
      const token = await makeToken(tx, { symbol: freshSymbol() });
      const holding = await makeHolding(tx, {
        userId: fixture.userId,
        accountId: fixture.accountId,
        tokenId: token.id,
      });
      // The arrival a person's queue answer wrote for this money.
      const [answered] = await tx
        .insert(schema.holdingTransactions)
        .values({
          userId: fixture.userId,
          holdingId: holding.id,
          tokenId: token.id,
          kind: 'transfer_in',
          quantity: '1000',
          occurredAt: T1,
          source: 'transfer-review',
          externalId: 'review-0',
        })
        .returning();

      const result = await ingest(
        txBatch(fixture, 'create', [
          entry(coin(token.symbol), 'in-1', '1000', { kind: 'transfer_in' }),
        ]),
        tx
      );

      expect(
        (await ledgerOf(tx, fixture.userId)).map((r) => [r.id, r.source, r.externalId, r.inputId])
      ).toEqual([[answered!.id, 'test-feed', 'in-1', result.inputId]]);
    });
  });

  /**
   * R55's starting point: `a1` and `b1` written by the input and then
   * unstamped, as rows written before PR-3 are, and a newer copy of `a1` with
   * no input on an imported holding of `a`, which the next run resolves to.
   */
  async function unstampedAcrossHoldings(tx: DatabaseTransaction) {
    const fixture = await owner(tx);
    const [a, b] = [
      await makeToken(tx, { symbol: freshSymbol() }),
      await makeToken(tx, { symbol: freshSymbol() }),
    ];
    const batch = txBatch(fixture, 'create', [
      entry(coin(a.symbol), 'a1', '1', { kind: 'deposit' }),
      entry(coin(b.symbol), 'b1', '2', { kind: 'deposit' }),
    ]);
    const first = await ingest(batch, tx);
    await tx
      .update(schema.holdingTransactions)
      .set({ inputId: null })
      .where(eq(schema.holdingTransactions.userId, fixture.userId));
    const [aCreated, bCreated] = first.createdHoldingIds;
    // The copy is the newer of the two, so only preferring the batch's own
    // holding stamps it.
    const aImported = await makeHolding(tx, {
      userId: fixture.userId,
      accountId: fixture.accountId,
      tokenId: a.id,
      externalId: `${a.symbol}-sync`,
      kind: 'feed',
    });
    await tx.insert(schema.holdingTransactions).values({
      userId: fixture.userId,
      holdingId: aImported.id,
      tokenId: a.id,
      kind: 'deposit',
      quantity: '1',
      occurredAt: T1,
      source: 'test-feed',
      externalId: 'a1',
      createdAt: new Date(Date.now() + 86_400_000),
    });
    const names = new Map([
      [aCreated, 'a-created'],
      [aImported.id, 'a-imported'],
      [bCreated, 'b-created'],
    ]);
    const ledger = async () =>
      (await ledgerOf(tx, fixture.userId))
        .map((r) => [r.externalId, names.get(r.holdingId), r.inputId, r.quantity])
        .sort((x, y) => String(x).localeCompare(String(y)));
    return { fixture, batch, inputId: first.inputId, aImported, ledger };
  }

  /**
   * R55: a feed row with no input (written before PR-3, or taken over by it)
   * is the row its re-send updates. Without the stamp the re-send would not
   * meet it on (input, external_id) and would insert beside it, refused by
   * `holding_tx_dedup`. The batch's rows span two holdings, and an older copy
   * of one event sits on a third: each event's stamp goes to one row, the one
   * on the holding the batch writes into, so nothing is refused.
   */
  test('a NULL-input feed row re-sent is stamped and updated, on every holding the batch spans', async () => {
    await withTestDb(async (tx) => {
      const { batch, inputId, ledger } = await unstampedAcrossHoldings(tx);

      await ingest(batch, tx);

      expect(await ledger()).toEqual([
        ['a1', 'a-created', null, '1'],
        ['a1', 'a-imported', inputId, '1'],
        ['b1', 'b-created', inputId, '2'],
      ]);
    });
  });

  // R58, on the copy R55 leaves behind: once the event is placed back on that
  // copy's holding, the input's row moves there and the copy goes, so the
  // event is held once, where the feed places it (A5 D-22).
  test('the copy R55 leaves gives way to the input row when the event is placed back on its holding (R58)', async () => {
    await withTestDb(async (tx) => {
      const { batch, inputId, aImported, ledger } = await unstampedAcrossHoldings(tx);
      await ingest(batch, tx);
      // The imported holding stops outranking the one ingest created.
      await tx
        .update(schema.holdings)
        .set({ externalId: null, createdAt: new Date(Date.now() + 86_400_000) })
        .where(eq(schema.holdings.id, aImported.id));
      const resent = {
        ...batch,
        entries: batch.entries.map((e) => (e.externalId === 'a1' ? { ...e, amount: '3' } : e)),
      };

      const runs = [await ingest(resent, tx), await ingest(resent, tx)];

      expect(runs.map((r) => [r.notices, r.earliestChangedAt])).toEqual([
        [[duplicatePlacementNotice(1)], T1],
        [[], null],
      ]);
      expect(await ledger()).toEqual([
        ['a1', 'a-created', inputId, '3'],
        ['b1', 'b-created', inputId, '2'],
      ]);
    });
  });

  /**
   * R58 (review I1): the input states `p1` on the holding ingest created, and
   * the imported holding the event now resolves to holds an older copy with no
   * input, as PR-3's (holding, source, external_id) arbiter left one. The
   * feed places the event, so it is held once, there: the copy goes and the
   * input's row moves onto that holding, and the run says so once (A5 D-22).
   */
  test('an event placed on a holding holding a NULL-input copy of it moves the input row there and removes the copy, once (R58)', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx);
      const token = await makeToken(tx, { symbol: freshSymbol() });
      const batch = txBatch(fixture, 'create', [
        entry(coin(token.symbol), 'p1', '1', { kind: 'deposit' }),
      ]);
      const first = await ingest(batch, tx);
      const [created] = first.createdHoldingIds;
      const imported = await makeHolding(tx, {
        userId: fixture.userId,
        accountId: fixture.accountId,
        tokenId: token.id,
        externalId: `${token.symbol}-sync`,
        kind: 'feed',
      });
      await tx.insert(schema.holdingTransactions).values({
        userId: fixture.userId,
        holdingId: imported.id,
        tokenId: token.id,
        kind: 'deposit',
        quantity: '0.5',
        occurredAt: T1,
        source: 'test-feed',
        externalId: 'p1',
      });

      const runs = [await ingest(batch, tx), await ingest(batch, tx)];

      expect(runs.map((r) => [r.notices, r.earliestChangedAt])).toEqual([
        [[duplicatePlacementNotice(1)], T1],
        [[], null],
      ]);
      const names = new Map([
        [created, 'created'],
        [imported.id, 'imported'],
      ]);
      expect(
        (await ledgerOf(tx, fixture.userId))
          .map((r) => [names.get(r.holdingId), r.inputId, r.quantity])
          .sort((x, y) => String(x).localeCompare(String(y)))
      ).toEqual([['imported', first.inputId, '1']]);
    });
  });

  // SC-1528: a batch too large for one statement is written in parts, and a
  // placement R58 finds in a later part is reported like one in the first.
  test('an R58 placement past the first statement of a large batch is still reported', async () => {
    await withTestDb(async (tx) => {
      await withLockWatch(tx, 'FeedIngest R58 1,700', async () => {
        const fixture = await owner(tx);
        const token = await makeToken(tx, { symbol: freshSymbol() });
        const ids = Array.from({ length: 1700 }, (_, i) => `p${i}`);
        const last = ids.at(-1)!;
        const batch = txBatch(
          fixture,
          'create',
          ids.map((id) => entry(coin(token.symbol), id, '1', { kind: 'deposit' }))
        );
        const first = await ingest(batch, tx);
        const imported = await makeHolding(tx, {
          userId: fixture.userId,
          accountId: fixture.accountId,
          tokenId: token.id,
          externalId: `${token.symbol}-sync`,
          kind: 'feed',
        });
        await tx.insert(schema.holdingTransactions).values({
          userId: fixture.userId,
          holdingId: imported.id,
          tokenId: token.id,
          kind: 'deposit',
          quantity: '0.5',
          occurredAt: T1,
          source: 'test-feed',
          externalId: last,
        });

        const again = await ingest(batch, tx);

        expect(again.notices).toEqual([duplicatePlacementNotice(1)]);
        const copies = (await ledgerOf(tx, fixture.userId)).filter((r) => r.externalId === last);
        const names = new Map([
          [first.createdHoldingIds[0], 'created'],
          [imported.id, 'imported'],
        ]);
        expect(
          copies
            .map((r) => [names.get(r.holdingId), r.inputId, r.quantity])
            .sort((x, y) => String(x).localeCompare(String(y)))
        ).toEqual([['imported', first.inputId, '1']]);
      });
    });
  }, 300_000); // Thousands of rows, on a CI box several times slower than a laptop, sometimes beside a second gate run (SC-1528).

  // SC-1528, the whole path at the size that failed: the TON Foundation wallet's
  // 7,182 events. Every statement ingest runs on the batch, not only the
  // ledger upsert, has to fit Postgres's parameter limit.
  test('a batch of 7,200 events lands whole, first time and re-sent', async () => {
    await withTestDb(async (tx) => {
      await withLockWatch(tx, 'FeedIngest 7,200', async () => {
        const fixture = await owner(tx);
        const token = await makeToken(tx, { symbol: freshSymbol() });
        const batch = txBatch(
          fixture,
          'create',
          Array.from({ length: 7200 }, (_, i) =>
            entry(
              coin(token.symbol),
              `ton-${i}`,
              i % 2 ? '-1' : '2',
              {
                kind: i % 2 ? 'withdraw' : 'deposit',
              },
              { occurredAt: new Date(T1.getTime() + i * 60_000) }
            )
          )
        );

        const first = await ingest(batch, tx);
        const again = await ingest(batch, tx);

        expect(first.entryOutcomes.filter((o) => o === 'landed')).toHaveLength(7200);
        expect(first.earliestChangedAt).toEqual(T1);
        expect(again.earliestChangedAt).toBeNull();
        expect(await ledgerOf(tx, fixture.userId)).toHaveLength(7200);
      });
    });
  }, 300_000); // Thousands of rows, on a CI box several times slower than a laptop, sometimes beside a second gate run (SC-1528).

  // The stamp is scoped by user as well as by account (review M3): another
  // user's row in the account is never stamped, so never moved.
  test("the stamp leaves another user's row in the account alone", async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx);
      const stranger = (await makeUser(tx)).id;
      const token = await makeToken(tx, { symbol: freshSymbol() });
      const theirs = await makeHolding(tx, {
        userId: stranger,
        accountId: fixture.accountId,
        tokenId: token.id,
      });
      const [copy] = await tx
        .insert(schema.holdingTransactions)
        .values({
          userId: stranger,
          holdingId: theirs.id,
          tokenId: token.id,
          kind: 'deposit',
          quantity: '1',
          occurredAt: T1,
          source: 'test-feed',
          externalId: 'u1',
        })
        .returning();

      const result = await ingest(
        txBatch(fixture, 'create', [entry(coin(token.symbol), 'u1', '1', { kind: 'deposit' })]),
        tx
      );

      const [after] = await tx
        .select()
        .from(schema.holdingTransactions)
        .where(eq(schema.holdingTransactions.id, copy!.id));
      expect([after!.holdingId, after!.inputId]).toEqual([theirs.id, null]);
      const [created] = result.createdHoldingIds;
      expect(
        (await ledgerOf(tx, fixture.userId)).map((r) => [r.externalId, r.holdingId, r.inputId])
      ).toEqual([['u1', created!, result.inputId]]);
    });
  });

  // The control for the stamp's guard: the input already states the event on
  // another holding, so a stamp would collide with it on the key.
  test('a NULL-input copy of an event the input already holds is left as it is', async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx);
      const token = await makeToken(tx, { symbol: freshSymbol() });
      const batch = txBatch(fixture, 'create', [
        entry(coin(token.symbol), 'c1', '1', { kind: 'deposit' }),
      ]);
      const first = await ingest(batch, tx);
      // Created later, so `findForIngest` keeps choosing the holding ingest made.
      const later = await makeHolding(tx, {
        userId: fixture.userId,
        accountId: fixture.accountId,
        tokenId: token.id,
        createdAt: new Date(Date.now() + 86_400_000),
      });
      await tx.insert(schema.holdingTransactions).values({
        userId: fixture.userId,
        holdingId: later.id,
        tokenId: token.id,
        kind: 'deposit',
        quantity: '1',
        occurredAt: T1,
        source: 'test-feed',
        externalId: 'c1',
      });

      await ingest(batch, tx);

      expect(
        (await ledgerOf(tx, fixture.userId))
          .map((r) => [r.holdingId === later.id ? 'copy' : 'held', r.inputId])
          .sort((x, y) => String(x).localeCompare(String(y)))
      ).toEqual([
        ['copy', null],
        ['held', first.inputId],
      ]);
    });
  });
});

/**
 * R56: migrations run before the new code is live, and a rollback keeps the
 * migration, so PR-3's write must hold against the key. It arbitrated on
 * (holding, source, external_id) and stamped the batch's input on insert. A
 * re-import meets its row on that key and never changes `input_id`, so it
 * cannot break the new one. The exception: a row that re-resolves to another
 * holding is a fresh insert there, under an (input, external_id) its first
 * holding already has, and that run fails until the new code is live.
 */
describe('version skew: the previous arbiter against the key (R56)', () => {
  test("PR-3's writes hold, and a row it re-resolves to another holding is refused", async () => {
    await withTestDb(async (tx) => {
      const fixture = await owner(tx);
      const token = await makeToken(tx, { symbol: freshSymbol() });
      const { userId, accountId } = fixture;
      const [first, other] = [
        await makeHolding(tx, { userId, accountId, tokenId: token.id }),
        await makeHolding(tx, { userId, accountId, tokenId: token.id }),
      ];
      const input = await Container.get(FeedInputRepository).findOrCreate(
        { userId, accountId, source: 'test-feed', credentialId: null, walletId: null },
        tx
      );
      const row = (holdingId: string, externalId: string, quantity = '1') => ({
        userId: fixture.userId,
        holdingId,
        tokenId: token.id,
        kind: 'deposit',
        quantity,
        occurredAt: T1,
        source: 'test-feed',
        externalId,
        inputId: input.id,
      });
      const ledger = Container.get(HoldingTransactionRepository);

      await ledger.bulkUpsert([row(first.id, 'e1'), row(first.id, 'e2')], tx);
      await ledger.bulkUpsert([row(first.id, 'e1', '5'), row(first.id, 'e3')], tx);
      expect(
        (await ledgerOf(tx, fixture.userId)).map((r) => [r.externalId, r.quantity, r.inputId])
      ).toEqual([
        ['e1', '5', input.id],
        ['e2', '1', input.id],
        ['e3', '1', input.id],
      ]);

      const refusal = (rows: ReturnType<typeof row>[]) =>
        tx
          .transaction((inner) => ledger.bulkUpsert(rows, inner))
          .then(
            () => null,
            (error: unknown) => {
              const cause = (error as { cause?: { code?: string; constraint_name?: string } })
                .cause;
              return [cause?.code, cause?.constraint_name];
            }
          );
      const refusedByKey = ['23505', 'holding_tx_input_external_uq'];
      expect(await refusal([row(other.id, 'e1')])).toEqual(refusedByKey);
      // The same exception inside one batch: one external id sent for two
      // holdings is two keys to the old arbiter and one to the new.
      expect(await refusal([row(first.id, 'e4'), row(other.id, 'e4')])).toEqual(refusedByKey);
    });
  });
});

describe('FeedIngestService.ingest, committed', () => {
  const createdUserIds: string[] = [];
  const createdSymbols: string[] = [];
  const createdInstitutionIds: string[] = [];
  const restores: Array<{ mockRestore: () => void }> = [];

  afterEach(async () => {
    for (const spy of restores.splice(0)) spy.mockRestore();
    const db = getDb();
    const users = createdUserIds.splice(0);
    const symbols = createdSymbols.splice(0);
    const institutions = createdInstitutionIds.splice(0);
    // Users first: their holdings are what keep the tokens restricted.
    if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
    if (symbols.length) {
      await db.delete(schema.tokens).where(inArray(schema.tokens.symbol, symbols));
    }
    if (institutions.length) {
      await db.delete(schema.institutions).where(inArray(schema.institutions.id, institutions));
    }
  });

  async function seed(symbols: readonly string[]) {
    createdSymbols.push(...symbols);
    return await getDb().transaction(async (tx) => {
      const fixture = await owner(tx);
      createdUserIds.push(fixture.userId);
      createdInstitutionIds.push(fixture.institutionId);
      for (const symbol of symbols) await makeToken(tx, { symbol });
      return fixture;
    });
  }

  const read = <T>(fn: (tx: DatabaseTransaction) => Promise<T>) => getDb().transaction(fn);

  test('two runs of the same swap give the same swap_group_id, and the second bumps no updated_at', async () => {
    const [out, inn] = [freshSymbol(), freshSymbol()];
    const fixture = await seed([out, inn]);
    const key = 'kraken-conversion:conv-1';
    const batch = txBatch(
      fixture,
      'create',
      [
        entry(
          coin(out),
          'conv-1',
          '-1',
          { kind: 'swap_out', counterQuantity: '1', priceNative: '1' },
          { groupKey: key, legacyAssets: { counter: coin(inn), priceQuote: coin(inn) } }
        ),
        entry(
          coin(inn),
          'conv-2',
          '1',
          { kind: 'swap_in', counterQuantity: '-1', priceNative: '1' },
          { groupKey: key, legacyAssets: { counter: coin(out), priceQuote: coin(out) } }
        ),
      ],
      'kraken-api'
    );

    const first = await ingest(batch);
    const snapshot = () =>
      read(async (tx) =>
        (await ledgerOf(tx, fixture.userId)).map((r) => ({
          id: r.id,
          kind: r.kind,
          swapGroupId: r.swapGroupId,
          groupId: r.groupId,
          updatedAt: r.updatedAt,
        }))
      );
    const before = await snapshot();
    await ingest(batch);
    const after = await snapshot();

    const swapGroupId = deterministicUuid(first.inputId, key);
    expect(
      before.map(({ kind, swapGroupId, groupId }) => ({ kind, swapGroupId, groupId }))
    ).toEqual([
      { kind: 'swap_out', swapGroupId, groupId: swapGroupId },
      { kind: 'swap_in', swapGroupId, groupId: swapGroupId },
    ]);
    expect(after).toEqual(before);
  });

  // R55: the stamp writes `input_id` and nothing else, so a re-send that
  // changes nothing bumps no `updated_at` and moves no label.
  test('a NULL-input feed row re-sent is stamped, and moves no updated_at or label', async () => {
    const symbolName = freshSymbol();
    const fixture = await seed([symbolName]);
    const batch = txBatch(fixture, 'create', [
      entry(coin(symbolName), 'n1', '-3', { kind: 'withdraw' }),
    ]);
    const first = await ingest(batch);
    await getDb()
      .update(schema.holdingTransactions)
      .set({ inputId: null })
      .where(eq(schema.holdingTransactions.userId, fixture.userId));
    const snapshot = () =>
      read(async (tx) =>
        (await ledgerOf(tx, fixture.userId)).map((r) => ({
          id: r.id,
          inputId: r.inputId,
          updatedAt: r.updatedAt,
          ledgerKind: r.ledgerKind,
          kindSubtype: r.kindSubtype,
          groupId: r.groupId,
          feeOf: r.feeOf,
          kindOrigin: r.kindOrigin,
        }))
      );
    const before = await snapshot();

    await ingest(batch);

    expect(before.map((r) => r.inputId)).toEqual([null]);
    expect(await snapshot()).toEqual(before.map((r) => ({ ...r, inputId: first.inputId })));
    await expectLabelsSettled(fixture.userId);
  });

  // N2: a second write of an input waits for the first, so it finds the
  // holding the first created. Unlocked, it would create its own while the
  // first's was uncommitted, and the key would then move the row onto it,
  // leaving the first holding empty beside it.
  test('two writes of one input that meet a new token make one holding', async () => {
    const symbolName = freshSymbol();
    const fixture = await seed([symbolName]);
    const { userId, accountId } = fixture;
    await getDb().transaction((tx) =>
      Container.get(FeedInputRepository).findOrCreate(
        { userId, accountId, source: 'test-feed', credentialId: null, walletId: null },
        tx
      )
    );
    const batch = txBatch(fixture, 'create', [
      entry(coin(symbolName), 'z1', '1', { kind: 'deposit' }),
    ]);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let wrote = () => {};
    const firstWrote = new Promise<void>((resolve) => {
      wrote = resolve;
    });
    const first = getDb().transaction(async (tx) => {
      await ingest(batch, tx);
      wrote();
      await held;
    });
    await firstWrote;
    const second = ingest(batch);
    await Bun.sleep(300);
    release();
    await Promise.all([first, second]);

    const holdings = await read((tx) => holdingsOf(tx, fixture.accountId));
    expect(holdings).toHaveLength(1);
    expect(
      (await read((tx) => ledgerOf(tx, fixture.userId))).map((r) => [r.externalId, r.holdingId])
    ).toEqual([['z1', holdings[0]!.id]]);
  });

  /**
   * Records, at each identity lookup and each provider call, how many
   * transactions are open; `failing` names symbols whose create-on-miss lookup
   * throws.
   */
  function instrument(failing: ReadonlySet<string> = new Set()) {
    const state = {
      open: 0,
      enriched: [] as number[],
      find: [] as number[],
      create: [] as number[],
      landings: [] as Array<{ open: number; landed: string[] }>,
    };
    const db = getDb();
    const openTransaction = db.transaction.bind(db);
    restores.push(
      spyOn(db, 'transaction').mockImplementation(((fn, config) =>
        openTransaction(async (tx) => {
          state.open += 1;
          try {
            return await fn(tx);
          } finally {
            state.open -= 1;
          }
        }, config)) as typeof db.transaction)
    );
    restores.push(
      spyOn(Container.get(ProviderRegistry), 'getIdentityEnrichers').mockReturnValue([
        {
          providerKey: 'probe',
          enrichTokenIdentity: async () => {
            state.enriched.push(state.open);
            return null;
          },
        } as never,
      ])
    );
    const service = Container.get(TokenIdentityService);
    const find = service.findByIdentity.bind(service);
    const create = service.findOrCreateByIdentity.bind(service);
    restores.push(
      spyOn(service, 'findByIdentity').mockImplementation(async (partial, transaction) => {
        state.find.push(state.open);
        return await find(partial, transaction);
      }),
      spyOn(service, 'findOrCreateByIdentity').mockImplementation(async (partial, transaction) => {
        state.create.push(state.open);
        if (partial.symbol && failing.has(partial.symbol)) {
          throw new Error(`lookup of ${partial.symbol} failed`);
        }
        return await create(partial, transaction);
      })
    );
    // The one decision of which entries land, read before and inside the transaction (R34b).
    const planner = Container.get(LandingPlanner);
    const plan = planner.plan.bind(planner);
    restores.push(
      spyOn(planner, 'plan').mockImplementation((async (
        ...args: Parameters<LandingPlanner['plan']>
      ) => {
        const planned = await plan(...args);
        state.landings.push({
          open: state.open,
          landed: planned.landed.map(({ entry }) => entry.externalId).sort(),
        });
        return planned;
      }) as LandingPlanner['plan'])
    );
    return state;
  }

  // Ruling R34. Creating a token asks every identity provider over the
  // network, so a creating batch does it before its own transaction opens and
  // makes no provider call inside it.
  test('a create batch finds or creates its tokens before its transaction opens, and asks no provider inside it', async () => {
    const [known, fresh] = [freshSymbol(), freshSymbol()];
    const fixture = await seed([known]);
    createdSymbols.push(fresh);
    const probe = instrument();
    const batch = txBatch(fixture, 'create', [
      entry(
        coin(known),
        'k1',
        '-1',
        { kind: 'withdraw', feeQuantity: '-0.1' },
        { legacyAssets: { fee: coin(fresh) } }
      ),
      entry(coin(fresh), 'f1', '2', { kind: 'deposit' }),
    ]);

    await ingest(batch);

    expect(probe.enriched).toEqual([0]);
    expect({ find: probe.find, create: probe.create }).toEqual({ find: [], create: [0, 0] });
    expect(probe.landings).toEqual([
      { open: 0, landed: ['f1', 'k1'] },
      { open: 1, landed: ['f1', 'k1'] },
    ]);
    const rows = await read((tx) => ledgerOf(tx, fixture.userId));
    const tokenOf = new Map(
      (await read((tx) => tokensWithSymbol(tx, [known, fresh]))).map((t) => [t.symbol, t.id])
    );
    expect(rows.map((r) => [r.externalId, r.tokenId, r.feeTokenId])).toEqual([
      ['f1', tokenOf.get(fresh)!, null],
      ['k1', tokenOf.get(known)!, tokenOf.get(fresh)!],
    ]);

    // The control: in a transaction the caller opened, resolution stays inside
    // it, so the probe can see an open transaction when there is one.
    const other = freshSymbol();
    createdSymbols.push(other);
    probe.enriched.length = 0;
    await getDb()
      .transaction(async (tx) => {
        await ingest(
          txBatch(fixture, 'create', [entry(coin(other), 'o1', '1', { kind: 'deposit' })]),
          tx
        );
        throw new Error('roll the control back');
      })
      .catch(() => undefined);
    expect(probe.enriched).toEqual([1]);
  });

  // Ruling R34b. Under find-only the holdings are read before the transaction
  // too, so the entries that land are known there and R32 holds exactly: a fee
  // token is created for an entry that lands, and for no other.
  test('a find-only batch reads its tokens and holdings before its transaction opens, and asks no provider inside it', async () => {
    const [held, notHeld, unknown, fee, unusedFee] = [
      freshSymbol(),
      freshSymbol(),
      freshSymbol(),
      freshSymbol(),
      freshSymbol(),
    ];
    const fixture = await seed([held, notHeld]);
    createdSymbols.push(unknown, fee, unusedFee);
    await getDb().transaction(async (tx) => {
      const [token] = await tokensWithSymbol(tx, [held]);
      await makeHolding(tx, {
        userId: fixture.userId,
        accountId: fixture.accountId,
        tokenId: token!.id,
        externalId: `${held}-wallet`,
      });
    });
    const probe = instrument();

    const result = await ingest(
      txBatch(fixture, 'find-only', [
        entry(
          coin(held),
          'h1',
          '-1',
          { kind: 'transfer_out', feeQuantity: '-0.1' },
          { legacyAssets: { fee: coin(fee) } }
        ),
        entry(
          coin(notHeld),
          'n1',
          '5',
          { kind: 'transfer_in', feeQuantity: '-0.1' },
          { legacyAssets: { fee: coin(unusedFee) } }
        ),
        entry(
          coin(held),
          'n1:fee',
          '-0.1',
          { kind: 'fee', sourceMetadata: { settles: 'n1' } },
          { settlesExternalId: 'n1' }
        ),
        entry(coin(unknown), 'u1', '7', { kind: 'transfer_in' }),
      ])
    );

    expect(probe.enriched).toEqual([0]);
    expect(probe.find).toEqual([0, 0, 0]);
    expect(probe.create).toEqual([0]);
    expect(probe.landings).toEqual([
      { open: 0, landed: ['h1'] },
      { open: 1, landed: ['h1'] },
    ]);
    expect(
      (await read((tx) => tokensWithSymbol(tx, [unknown, fee, unusedFee]))).map((t) => t.symbol)
    ).toEqual([fee]);
    expect((await read((tx) => ledgerOf(tx, fixture.userId))).map((r) => r.externalId)).toEqual([
      'h1',
    ]);
    expect(result.notices).toEqual([skippedNotice(2, 2)]);
  });

  // M1. The account is checked before anything is resolved, so a batch that
  // will be refused leaves no token behind and asks no provider.
  test("a batch naming another user's account is refused before any token is created or any provider asked", async () => {
    const fixture = await seed([]);
    const stranger = await seed([]);
    const fresh = freshSymbol();
    createdSymbols.push(fresh);
    const probe = instrument();

    const refused = await ingest(
      txBatch({ userId: fixture.userId, accountId: stranger.accountId }, 'create', [
        entry(coin(fresh), 'f1', '1', { kind: 'deposit' }),
      ])
    ).catch((error: unknown) => error);

    expect((refused as Error).message).toBe(
      `FeedIngestService: user ${fixture.userId} has no account ${stranger.accountId}`
    );
    expect({ enriched: probe.enriched, find: probe.find, create: probe.create }).toEqual({
      enriched: [],
      find: [],
      create: [],
    });
    expect(await read((tx) => tokensWithSymbol(tx, [fresh]))).toEqual([]);
  });

  // Ruling R35 with no caller transaction: the lookup runs before ingest opens
  // its own, fails once, is reported once, and is not tried again inside.
  test('a lookup that fails before the transaction opens is reported once, and the batch is written without it', async () => {
    const [good, badPrimary, badFee] = [freshSymbol(), freshSymbol(), freshSymbol()];
    const fixture = await seed([good]);
    createdSymbols.push(badPrimary, badFee);
    const probe = instrument(new Set([badPrimary, badFee]));

    const result = await ingest(
      txBatch(fixture, 'create', [
        entry(coin(badPrimary), 'b1', '1', { kind: 'deposit' }),
        entry(coin(badPrimary), 'b2', '2', { kind: 'deposit' }),
        entry(
          coin(good),
          'g1',
          '-3',
          { kind: 'withdraw', feeQuantity: '-1' },
          { legacyAssets: { fee: coin(badFee) } }
        ),
      ])
    );

    expect(probe.create).toEqual([0, 0, 0]);
    expect(result.notices).toEqual([
      `Failed to resolve token identity ${badPrimary}: lookup of ${badPrimary} failed`,
      `Failed to resolve token identity ${badFee}: lookup of ${badFee} failed`,
    ]);
    expect(
      (await read((tx) => ledgerOf(tx, fixture.userId))).map((r) => [r.externalId, r.feeTokenId])
    ).toEqual([['g1', null]]);
  });

  test('legs linked inside the batch leave every label settled', async () => {
    const [stock, cash] = [freshSymbol(), freshSymbol()];
    const fixture = await seed([stock, cash]);

    await ingest(
      txBatch(
        fixture,
        'create',
        [
          entry(
            coin(stock),
            't1',
            '2',
            { kind: 'buy', counterQuantity: '-1000', feeQuantity: '-1', priceNative: '500' },
            {
              legacyAssets: { counter: coin(cash), fee: coin(cash), priceQuote: coin(cash) },
            }
          ),
          entry(
            coin(cash),
            't1:settle',
            '-1000',
            { kind: 'settle_out', sourceMetadata: { settles: 't1' } },
            { settlesExternalId: 't1' }
          ),
          entry(
            coin(cash),
            't1:fee',
            '-1',
            { kind: 'fee', sourceMetadata: { settles: 't1' } },
            { settlesExternalId: 't1' }
          ),
        ],
        'bybit-api'
      )
    );

    const rows = await read((tx) => ledgerOf(tx, fixture.userId));
    expect(rows.map((r) => [r.externalId, r.settlesTransactionId !== null])).toEqual([
      ['t1', false],
      ['t1:fee', true],
      ['t1:settle', true],
    ]);
    await expectLabelsSettled(fixture.userId);
  });
});

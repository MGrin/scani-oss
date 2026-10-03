/**
 * Mirror legs (spec D8, foundation A2 Task 12): a feed's outflow that a step
 * sends to the user's own account writes the arrival there, by today's
 * queue-arrival rule, when that account may take one (R44, R47). Driven
 * through ingest, where classification runs.
 *
 * Most tests run inside a rolled-back transaction. The last block commits,
 * because `updated_at` is `now()`, which one transaction reads as one instant,
 * and `expectLabelsSettled` reads committed rows.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { type DatabaseTransaction, getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { pendingPredicate } from '../../../../src/lib/transfer-review-queue';
import { FeedInputRepository } from '../../../../src/repositories/FeedInputRepository';
import { HoldingCoverageRepository } from '../../../../src/repositories/HoldingCoverageRepository';
import { MirrorLegWriter } from '../../../../src/services/feeds/classification/MirrorLegWriter';
import { deterministicUuid } from '../../../../src/services/feeds/deterministic-id';
import { FeedIngestService } from '../../../../src/services/feeds/FeedIngestService';
import type { FeedBatch, FeedEntry } from '../../../../src/services/feeds/feed-batch';
import { BalanceShadowService } from '../../../../src/services/foundation/BalanceShadowService';
import { TransferReviewService } from '../../../../src/services/TransferReviewService';
import { withTestDb } from '../../../../test/helpers/db';
import { makeCredential, makeInstitution, makeUser } from '../../../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../../../test/helpers/factories-extra';
import { expectLabelsSettled } from '../../../../test/helpers/labels-settled';
import { differencesOf } from '../../../../test/helpers/shadow-runs';

const SOURCE = 'test-feed';
const T1 = new Date('2026-07-01T10:00:00Z');
const FETCHED = new Date('2026-07-10T00:00:00Z');

const freshSymbol = () => `T${randomUUID().replace(/-/g, '').toUpperCase()}`;
/** A wallet address built at run time, so no address-shaped literal is committed. */
const wallet = (digit: string) => `0x${digit.repeat(40)}`;

const ingest = (batch: FeedBatch, tx?: DatabaseTransaction) =>
  Container.get(FeedIngestService).ingest(batch, tx);

interface World {
  userId: string;
  sourceAccountId: string;
  savingsAccountId: string;
  savingsInstitutionId: string;
  sourceInstitutionId: string;
  symbol: string;
  tokenId: string;
  inputId: string;
}

type RuleShape = Pick<typeof schema.feedMatchRules.$inferInsert, 'matchField' | 'pattern'>;

/** "A payment described 'to savings' goes to savings." */
const TO_SAVINGS: RuleShape = { matchField: 'description', pattern: 'to savings' };

async function addRule(tx: DatabaseTransaction, w: World, rule: RuleShape): Promise<void> {
  await tx.insert(schema.feedMatchRules).values({
    userId: w.userId,
    inputId: w.inputId,
    ...rule,
    destinationAccountId: w.savingsAccountId,
    createdBy: 'person',
  });
}

/**
 * A feed account and a savings account nothing feeds, with one rule on the
 * feed's input sending matching payments to savings (`TO_SAVINGS` unless
 * named; null for none).
 */
async function world(
  tx: DatabaseTransaction,
  opts: {
    sourceMetadata?: Record<string, unknown>;
    symbol?: string;
    rule?: RuleShape | null;
  } = {}
): Promise<World> {
  const userId = (await makeUser(tx)).id;
  const sourceInstitution = await makeInstitution(tx);
  const source = await makeAccount(tx, {
    userId,
    institutionId: sourceInstitution.id,
    ...(opts.sourceMetadata ? { metadata: opts.sourceMetadata } : {}),
  });
  const savingsInstitution = await makeInstitution(tx);
  const savings = await makeAccount(tx, { userId, institutionId: savingsInstitution.id });
  const token = await makeToken(tx, { symbol: opts.symbol ?? freshSymbol() });
  const input = await Container.get(FeedInputRepository).findOrCreate(
    { userId, accountId: source.id, source: SOURCE, credentialId: null, walletId: null },
    tx
  );
  const made: World = {
    userId,
    sourceAccountId: source.id,
    savingsAccountId: savings.id,
    savingsInstitutionId: savingsInstitution.id,
    sourceInstitutionId: sourceInstitution.id,
    symbol: token.symbol,
    tokenId: token.id,
    inputId: input.id,
  };
  const rule = opts.rule === undefined ? TO_SAVINGS : opts.rule;
  if (rule !== null) await addRule(tx, made, rule);
  return made;
}

function entry(
  w: World,
  externalId: string,
  amount: string,
  fields: Partial<FeedEntry> = {}
): FeedEntry {
  return {
    externalId,
    asset: {
      identity: { symbol: w.symbol, name: w.symbol },
      typeCode: 'crypto',
      lookup: 'catalog-symbol',
    },
    amount,
    occurredAt: T1,
    legacy: {
      kind: amount.startsWith('-') ? 'withdraw' : 'deposit',
      source: SOURCE,
      sourceMetadata: {},
    },
    ...fields,
  };
}

function batchOf(w: World, entries: FeedEntry[]): FeedBatch {
  return {
    userId: w.userId,
    input: { accountId: w.sourceAccountId, source: SOURCE, credentialId: null, walletId: null },
    fetchedAt: FETCHED,
    window: { from: T1, to: FETCHED, complete: false },
    checkpoints: [],
    entries,
    absences: [],
    legacy: {
      holdingMatch: 'ingest-order',
      holdingPolicy: 'create',
      holdingSource: 'ingest-backfill',
      arrival: null,
      writesCache: false,
      createdWithoutCheckpoint: 'zero',
      cacheObservation: null,
      derivesTradeLegs: false,
      holdingFailure: 'skip-entry',
      absence: null,
      clearsAbsenceTally: false,
      createdCheckpointMeta: null,
      unhideOnNonZero: false,
      unchangedCheckpoint: 'append',
      zeroOpensHolding: true,
    },
    notices: [],
  };
}

/** The "to savings" outflow of 250 and an unmatched one of 40. */
const payments = (w: World) =>
  batchOf(w, [
    entry(w, 'out-1', '-250', { description: 'To Savings', counterparty: 'Savings account' }),
    entry(w, 'out-2', '-40', { description: 'Groceries' }),
  ]);

const ledgerOf = (tx: DatabaseTransaction, userId: string) =>
  tx
    .select()
    .from(schema.holdingTransactions)
    .where(eq(schema.holdingTransactions.userId, userId))
    .orderBy(asc(schema.holdingTransactions.externalId));

const holdingsIn = (tx: DatabaseTransaction, accountId: string) =>
  tx
    .select()
    .from(schema.holdings)
    .where(eq(schema.holdings.accountId, accountId))
    .orderBy(asc(schema.holdings.createdAt), asc(schema.holdings.id));

const observationsOf = (tx: DatabaseTransaction, holdingId: string) =>
  tx
    .select()
    .from(schema.holdingBalanceObservations)
    .where(eq(schema.holdingBalanceObservations.holdingId, holdingId))
    .orderBy(asc(schema.holdingBalanceObservations.observedAt));

const legsOf = (rows: ReadonlyArray<typeof schema.holdingTransactions.$inferSelect>) =>
  rows.filter((r) => r.source === 'feed-mirror');

async function mirrorDifferences(tx: DatabaseTransaction, userId: string, holdingId: string) {
  const { runId } = await Container.get(BalanceShadowService).run(
    { asOf: new Date(), pastInstants: [], userId },
    tx
  );
  return (await differencesOf(tx, runId)).filter((d) => d.holdingId === holdingId);
}

describe('a mirror leg into an account nothing feeds', () => {
  test('a destination with no holding of the asset gets a snapshot holding and a mirror leg; replaying the batch writes no second leg', async () => {
    await withTestDb(async (tx) => {
      const w = await world(tx);
      const result = await ingest(payments(w), tx);

      const [opened, ...others] = await holdingsIn(tx, w.savingsAccountId);
      expect(others).toEqual([]);
      expect(opened).toMatchObject({
        tokenId: w.tokenId,
        kind: 'snapshot',
        source: 'manual',
        arrival: 'user_confirmed',
        balance: '250',
        startsAt: T1,
      });
      expect(result.mirrorHoldingIds).toEqual([opened!.id]);
      // Today's queue answer runs none of the feed's own post-steps on its destination.
      expect(result.touchedHoldingIds).not.toContain(opened!.id);

      const [copy, ...more] = await observationsOf(tx, opened!.id);
      expect(more).toEqual([]);
      expect(copy).toMatchObject({
        balance: '250',
        source: 'holding-open',
        sourceMetadata: { origin: 'createHoldingWithEvent', source: 'manual' },
        role: 'snapshot',
        authority: 'person',
        inputId: null,
        cause: 'flow',
      });

      const [leg] = legsOf(await ledgerOf(tx, w.userId));
      const source = (await ledgerOf(tx, w.userId)).find((r) => r.externalId === 'out-1');
      expect(leg).toMatchObject({
        holdingId: opened!.id,
        tokenId: w.tokenId,
        kind: 'transfer_in',
        quantity: '250',
        occurredAt: T1,
        externalId: 'out-1:mirror',
        inputId: w.inputId,
        counterparty: 'Savings account',
        description: null,
        sourceMetadata: {
          outflowTransactionId: source!.id,
          createdDestinationHolding: true,
          movedDestinationAnchor: false,
        },
      });

      await ingest(payments(w), tx);
      expect(legsOf(await ledgerOf(tx, w.userId))).toHaveLength(1);
      expect(await holdingsIn(tx, w.savingsAccountId)).toHaveLength(1);
      expect((await holdingsIn(tx, w.savingsAccountId))[0]!.balance).toBe('250');
    });
  });

  test('an opening below 1e-6 is written in plain notation on the cache and its copy, as the leg is (N6)', async () => {
    await withTestDb(async (tx) => {
      const w = await world(tx);
      await ingest(
        batchOf(w, [entry(w, 'out-dust', '-0.00000005', { description: 'To Savings' })]),
        tx
      );

      const [opened] = await holdingsIn(tx, w.savingsAccountId);
      const [copy] = await observationsOf(tx, opened!.id);
      const [leg] = legsOf(await ledgerOf(tx, w.userId));
      expect({
        balance: opened?.balance,
        observation: copy?.balance,
        leg: leg?.quantity,
      }).toEqual({ balance: '0.00000005', observation: '0.00000005', leg: '0.00000005' });
    });
  });

  // `transfer-arrival.ts` says a mirror leg and the queue's `internal` answer
  // apply one rule to a destination. Held to it row for row: the same amount
  // leaves twice, once matched by the rule and once answered in the queue, each
  // into an account nothing feeds and that holds no position yet.
  test.each([['250'], ['0.00000005']])(
    "a mirror leg opens the holding and the opening the queue's internal answer opens, column for column (%s)",
    async (amount) => {
      await withTestDb(async (tx) => {
        const w = await world(tx);
        const answered = await makeAccount(tx, {
          userId: w.userId,
          institutionId: w.savingsInstitutionId,
        });
        await ingest(
          batchOf(w, [
            entry(w, 'out-leg', `-${amount}`, { description: 'To Savings' }),
            entry(w, 'out-queue', `-${amount}`, { description: 'Groceries' }),
          ]),
          tx
        );
        const question = (await ledgerOf(tx, w.userId)).find((r) => r.externalId === 'out-queue');
        expect(
          await Container.get(TransferReviewService).resolve(w.userId, question!.id, 'internal', {
            destination: { accountId: answered.id, holdingId: null },
            transaction: tx,
          })
        ).toEqual({ ok: true });

        const [byLeg, ...restByLeg] = await holdingsIn(tx, w.savingsAccountId);
        const [byAnswer, ...restByAnswer] = await holdingsIn(tx, answered.id);
        expect([restByLeg, restByAnswer]).toEqual([[], []]);
        // Which row it is, and the two instants each write reads off its own clock.
        const holdingAsOpened = ({
          id: _id,
          accountId: _accountId,
          lastUpdated: _lastUpdated,
          createdAt: _createdAt,
          ...columns
        }: typeof schema.holdings.$inferSelect) => columns;
        expect(holdingAsOpened(byLeg!)).toEqual(holdingAsOpened(byAnswer!));
        // Stated as well as compared: two rows that agree can both be wrong (R84).
        expect(holdingAsOpened(byLeg!)).toMatchObject({
          kind: 'snapshot',
          startsAt: T1,
          balance: amount,
          source: 'manual',
          arrival: 'user_confirmed',
          externalId: null,
          label: null,
        });

        const openingAsWritten = ({
          id: _id,
          holdingId: _holdingId,
          observedAt: _observedAt,
          createdAt: _createdAt,
          ...columns
        }: typeof schema.holdingBalanceObservations.$inferSelect) => columns;
        const openingsByLeg = (await observationsOf(tx, byLeg!.id)).map(openingAsWritten);
        const openingsByAnswer = (await observationsOf(tx, byAnswer!.id)).map(openingAsWritten);
        expect(openingsByLeg).toEqual(openingsByAnswer);
        expect(openingsByLeg).toHaveLength(1);
        expect(openingsByLeg[0]).toMatchObject({
          balance: amount,
          source: 'holding-open',
          sourceMetadata: { origin: 'createHoldingWithEvent', source: 'manual' },
          role: 'snapshot',
          authority: 'person',
          inputId: null,
          cause: 'flow',
          supersededAt: null,
          gapReview: null,
        });
      });
    }
  );

  test('the source row and the mirror leg share group_id and read transfer_out / transfer_in', async () => {
    await withTestDb(async (tx) => {
      const w = await world(tx);
      await ingest(payments(w), tx);

      const rows = await ledgerOf(tx, w.userId);
      const source = rows.find((r) => r.externalId === 'out-1')!;
      const [leg] = legsOf(rows);
      const group = deterministicUuid(w.inputId, `mirror:${source.id}`);
      const labels = (r: typeof source) => ({
        ledgerKind: r.ledgerKind,
        groupId: r.groupId,
        transferGroupId: r.transferGroupId,
        kindOrigin: r.kindOrigin,
        transferReview: r.transferReview,
      });

      expect(labels(source)).toEqual({
        ledgerKind: 'transfer_out',
        groupId: group,
        transferGroupId: group,
        kindOrigin: 'rule',
        transferReview: null,
      });
      expect(labels(leg!)).toEqual({
        ledgerKind: 'transfer_in',
        groupId: group,
        transferGroupId: group,
        kindOrigin: 'mirror',
        transferReview: null,
      });
      const unmatched = rows.find((r) => r.externalId === 'out-2')!;
      expect([unmatched.ledgerKind, unmatched.kindOrigin, unmatched.transferGroupId]).toEqual([
        'outflow',
        'source',
        null,
      ]);
    });
  });

  test("the source row with only the group leaves today's transfer-review queue (R48)", async () => {
    await withTestDb(async (tx) => {
      const w = await world(tx);
      await ingest(payments(w), tx);

      const pending = await tx
        .select({ externalId: schema.holdingTransactions.externalId })
        .from(schema.holdingTransactions)
        .where(pendingPredicate(w.userId))
        .orderBy(asc(schema.holdingTransactions.externalId));
      // The unmatched outflow is the control: it is still a question.
      expect(pending.map((r) => r.externalId)).toEqual(['out-2']);
    });
  });

  test('an existing snapshot holding takes the leg and its unobserved anchor moves by the amount', async () => {
    await withTestDb(async (tx) => {
      const w = await world(tx);
      const kept = await makeHolding(tx, {
        userId: w.userId,
        accountId: w.savingsAccountId,
        tokenId: w.tokenId,
        balance: '100',
        kind: 'snapshot',
        startsAt: new Date('2026-08-01T00:00:00Z'),
      });
      const result = await ingest(payments(w), tx);

      const [holding] = await holdingsIn(tx, w.savingsAccountId);
      expect(holding).toMatchObject({
        id: kept.id,
        balance: '350',
        kind: 'snapshot',
        startsAt: T1,
      });
      expect(result.mirrorHoldingIds).toEqual([kept.id]);
      const [copy] = await observationsOf(tx, kept.id);
      expect(copy).toMatchObject({
        balance: '350',
        source: 'sync-capture',
        sourceMetadata: { origin: 'updateHolding' },
        role: 'snapshot',
        authority: 'person',
        inputId: null,
      });
      expect(legsOf(await ledgerOf(tx, w.userId))[0]?.sourceMetadata).toMatchObject({
        createdDestinationHolding: false,
        movedDestinationAnchor: true,
      });
    });
  });

  test('a typed deposit of the same amount within a day is taken over, and the anchor stays', async () => {
    await withTestDb(async (tx) => {
      const w = await world(tx);
      const kept = await makeHolding(tx, {
        userId: w.userId,
        accountId: w.savingsAccountId,
        tokenId: w.tokenId,
        balance: '350',
        kind: 'snapshot',
      });
      const [typed] = await tx
        .insert(schema.holdingTransactions)
        .values({
          userId: w.userId,
          holdingId: kept.id,
          tokenId: w.tokenId,
          kind: 'deposit',
          quantity: '250',
          occurredAt: new Date(T1.getTime() + 60 * 60 * 1000),
          source: 'user-balance-edit',
          externalId: 'typed-deposit',
        })
        .returning();
      await ingest(payments(w), tx);

      expect((await holdingsIn(tx, w.savingsAccountId))[0]?.balance).toBe('350');
      const rows = await ledgerOf(tx, w.userId);
      expect(rows.find((r) => r.id === typed!.id)).toBeUndefined();
      expect(legsOf(rows)[0]?.sourceMetadata).toMatchObject({
        movedDestinationAnchor: false,
        adoptedBalanceEdit: { externalId: 'typed-deposit', quantity: '250' },
      });
      expect(await observationsOf(tx, kept.id)).toEqual([]);
    });
  });

  test('after a mirror leg the balance shadow reads the destination as match', async () => {
    await withTestDb(async (tx) => {
      const opened = await world(tx);
      await ingest(payments(opened), tx);
      const [created] = await holdingsIn(tx, opened.savingsAccountId);

      const reused = await world(tx);
      const kept = await makeHolding(tx, {
        userId: reused.userId,
        accountId: reused.savingsAccountId,
        tokenId: reused.tokenId,
        balance: '100',
        kind: 'snapshot',
      });
      await tx.insert(schema.holdingBalanceObservations).values({
        userId: reused.userId,
        holdingId: kept.id,
        balance: '100',
        observedAt: new Date('2026-06-01T00:00:00Z'),
        source: 'user-entered',
        role: 'snapshot',
        authority: 'person',
        cause: 'flow',
      });
      await ingest(payments(reused), tx);

      expect(await mirrorDifferences(tx, opened.userId, created!.id)).toEqual([]);
      expect(await mirrorDifferences(tx, reused.userId, kept.id)).toEqual([]);
      // The control: the same reading does see a destination whose cache is off.
      await tx
        .update(schema.holdings)
        .set({ balance: '999' })
        .where(eq(schema.holdings.id, kept.id));
      expect(await mirrorDifferences(tx, reused.userId, kept.id)).not.toEqual([]);
    });
  });
});

describe('a destination that takes no mirror leg', () => {
  test('a destination whose holding is feed writes no mirror leg', async () => {
    await withTestDb(async (tx) => {
      const w = await world(tx);
      await makeHolding(tx, {
        userId: w.userId,
        accountId: w.savingsAccountId,
        tokenId: w.tokenId,
        balance: '100',
        kind: 'feed',
      });
      const result = await ingest(payments(w), tx);

      const rows = await ledgerOf(tx, w.userId);
      expect(legsOf(rows)).toEqual([]);
      expect(result.mirrorHoldingIds).toEqual([]);
      const source = rows.find((r) => r.externalId === 'out-1')!;
      expect([source.ledgerKind, source.kindOrigin, source.transferGroupId]).toEqual([
        'outflow',
        'source',
        null,
      ]);
      expect((await holdingsIn(tx, w.savingsAccountId))[0]?.balance).toBe('100');
    });
  });

  test('an account with a feed input, a sync owner or a linked wallet takes none, even into a lone snapshot holding (R47)', async () => {
    await withTestDb(async (tx) => {
      const fed = await world(tx);
      await Container.get(FeedInputRepository).findOrCreate(
        {
          userId: fed.userId,
          accountId: fed.savingsAccountId,
          source: 'statement',
          credentialId: null,
          walletId: null,
        },
        tx
      );

      const synced = await world(tx);
      await makeCredential(tx, {
        userId: synced.userId,
        institutionId: synced.savingsInstitutionId,
      });

      const linked = await world(tx);
      const [ownWallet] = await tx
        .insert(schema.userWallets)
        .values({ userId: linked.userId, walletAddress: wallet('d'), isActive: false })
        .returning();
      await tx
        .update(schema.accounts)
        .set({ metadata: { userWalletId: ownWallet!.id } })
        .where(eq(schema.accounts.id, linked.savingsAccountId));

      for (const w of [fed, synced, linked]) {
        const lone = await makeHolding(tx, {
          userId: w.userId,
          accountId: w.savingsAccountId,
          tokenId: w.tokenId,
          balance: '100',
          kind: 'snapshot',
        });
        const result = await ingest(payments(w), tx);
        expect(legsOf(await ledgerOf(tx, w.userId))).toEqual([]);
        expect(result.mirrorHoldingIds).toEqual([]);
        expect((await holdingsIn(tx, w.savingsAccountId)).map((h) => [h.id, h.balance])).toEqual([
          [lone.id, '100'],
        ]);
      }
    });
  });

  test('a holding of unknown kind, or two holdings of the asset, take none and say so (R44)', async () => {
    await withTestDb(async (tx) => {
      const unknown = await world(tx);
      const unclassified = await makeHolding(tx, {
        userId: unknown.userId,
        accountId: unknown.savingsAccountId,
        tokenId: unknown.tokenId,
        balance: '100',
      });
      const unknownResult = await ingest(payments(unknown), tx);

      const two = await world(tx);
      for (const label of ['Pot A', 'Pot B']) {
        await makeHolding(tx, {
          userId: two.userId,
          accountId: two.savingsAccountId,
          tokenId: two.tokenId,
          balance: '100',
          kind: 'snapshot',
          label,
        });
      }
      const twoResult = await ingest(payments(two), tx);

      expect(legsOf(await ledgerOf(tx, unknown.userId))).toEqual([]);
      expect(legsOf(await ledgerOf(tx, two.userId))).toEqual([]);
      expect(unknownResult.notices).toContain(
        `mirror-skipped-unknown-kind: the arrival of out-1 was not written into holding ${unclassified.id}, whose kind is not known yet`
      );
      expect(twoResult.notices).toContain(
        `mirror-skipped-ambiguous-holding: the arrival of out-1 was not written, because account ${two.savingsAccountId} holds that asset in more than one position`
      );
    });
  });

  test('an inflow a rule sends somewhere writes no leg', async () => {
    await withTestDb(async (tx) => {
      const w = await world(tx);
      const result = await ingest(
        batchOf(w, [entry(w, 'in-1', '250', { description: 'to savings' })]),
        tx
      );

      expect(legsOf(await ledgerOf(tx, w.userId))).toEqual([]);
      expect(result.mirrorHoldingIds).toEqual([]);
      expect(await holdingsIn(tx, w.savingsAccountId)).toEqual([]);
    });
  });

  test("an own wallet's account takes no leg, so an own-address match writes nothing (R47)", async () => {
    await withTestDb(async (tx) => {
      const w = await world(tx, { sourceMetadata: { chainId: '1' } });
      const address = wallet('e');
      const [ownWallet] = await tx
        .insert(schema.userWallets)
        .values({ userId: w.userId, walletAddress: address })
        .returning();
      const walletInstitution = await makeInstitution(tx);
      const walletAccount = await makeAccount(tx, {
        userId: w.userId,
        institutionId: walletInstitution.id,
        metadata: { userWalletId: ownWallet!.id, chainId: 1 },
      });
      await makeHolding(tx, {
        userId: w.userId,
        accountId: walletAccount.id,
        tokenId: w.tokenId,
        balance: '100',
        kind: 'snapshot',
      });
      // The positive control: the step did name the wallet's account, and it
      // was eligibility that refused it, not a step that never matched.
      const asked = spyOn(Container.get(MirrorLegWriter), 'eligibleDestination');
      try {
        await ingest(
          batchOf(w, [
            entry(w, 'out-1', '-250', {
              counterparty: address.toUpperCase().replace('0X', '0x'),
            }),
          ]),
          tx
        );
        expect(asked.mock.calls.map(([userId, accountId]) => [userId, accountId])).toEqual([
          [w.userId, walletAccount.id],
        ]);
        expect(await asked.mock.results[0]?.value).toBeNull();
      } finally {
        asked.mockRestore();
      }

      const rows = await ledgerOf(tx, w.userId);
      expect(legsOf(rows)).toEqual([]);
      expect(
        rows.map((r) => [r.externalId, r.ledgerKind, r.kindOrigin, r.transferGroupId])
      ).toEqual([['out-1', 'outflow', 'source', null]]);
    });
  });
});

describe('classification through ingest', () => {
  test('a counterparty rule matches through transfer_counterparty_key, from the column or the payload', async () => {
    await withTestDb(async (tx) => {
      const w = await world(tx, {
        rule: { matchField: 'counterparty', pattern: 'Pay 100.00 USD to Example Savings' },
      });
      const result = await ingest(
        batchOf(w, [
          entry(w, 'by-column', '-250', { counterparty: 'pay 2,500.00 eur to  Example Savings' }),
          entry(w, 'by-payload', '-30', {
            legacy: {
              kind: 'withdraw',
              source: SOURCE,
              sourceMetadata: {},
              rawPayload: { to: 'Example Savings' },
            },
          }),
          entry(w, 'elsewhere', '-40', { counterparty: 'Pay 40.00 USD to Example Landlord' }),
        ]),
        tx
      );

      const rows = await ledgerOf(tx, w.userId);
      expect(legsOf(rows).map((r) => r.externalId)).toEqual([
        'by-column:mirror',
        'by-payload:mirror',
      ]);
      expect(rows.find((r) => r.externalId === 'elsewhere')?.transferGroupId).toBeNull();
      expect(result.mirrorHoldingIds).toHaveLength(1);
      expect((await holdingsIn(tx, w.savingsAccountId))[0]?.balance).toBe('280');
    });
  });

  test('a row a person took back from a rule is not decided again (ruleWritablePredicate)', async () => {
    await withTestDb(async (tx) => {
      const w = await world(tx, { rule: null });
      const batch = batchOf(w, [
        entry(w, 'out-1', '-250', { description: 'To Savings' }),
        entry(w, 'out-3', '-60', { description: 'To Savings' }),
      ]);
      await ingest(batch, tx);
      // What `reopen` leaves on a rule-answered row: no answer, and the
      // person's mark that they overruled it.
      await tx
        .update(schema.holdingTransactions)
        .set({ transferReviewSource: 'user' })
        .where(
          and(
            eq(schema.holdingTransactions.userId, w.userId),
            eq(schema.holdingTransactions.externalId, 'out-1')
          )
        );
      await addRule(tx, w, TO_SAVINGS);
      await ingest(batch, tx);

      const rows = await ledgerOf(tx, w.userId);
      // The control, `out-3`, is decided by the same rule on the same replay.
      expect(legsOf(rows).map((r) => r.externalId)).toEqual(['out-3:mirror']);
      const overruled = rows.find((r) => r.externalId === 'out-1')!;
      expect([overruled.ledgerKind, overruled.kindOrigin, overruled.transferGroupId]).toEqual([
        'outflow',
        'source',
        null,
      ]);
    });
  });

  // m5 (R51, Task 13): the leg is keyed like every feed row, by (input,
  // external_id). A replay that finds it on another holding updates it there,
  // where the old target (holding, source, external_id) would have inserted a
  // second leg, which the key refuses. The holding it left is summarized again
  // (review M1), so its coverage no longer claims the leg.
  test('a mirror leg replayed under the new key writes no second leg, and the holding it left is re-summarized (m5)', async () => {
    await withTestDb(async (tx) => {
      const w = await world(tx);
      await ingest(payments(w), tx);
      const [opened] = await holdingsIn(tx, w.savingsAccountId);
      const elsewhereAccount = await makeAccount(tx, {
        userId: w.userId,
        institutionId: (await makeInstitution(tx)).id,
      });
      const elsewhere = await makeHolding(tx, {
        userId: w.userId,
        accountId: elsewhereAccount.id,
        tokenId: w.tokenId,
        kind: 'snapshot',
      });
      const mine = eq(schema.holdingTransactions.userId, w.userId);
      await tx
        .update(schema.holdingTransactions)
        .set({ holdingId: elsewhere.id })
        .where(and(mine, eq(schema.holdingTransactions.source, 'feed-mirror')));
      await tx
        .delete(schema.holdingTransactions)
        .where(and(mine, eq(schema.holdingTransactions.externalId, 'out-1')));
      const coverage = Container.get(HoldingCoverageRepository);
      await coverage.syncTxBoundsFromLedger([elsewhere.id], tx);
      const boundsOf = async (holdingId: string) => {
        const [row] = await tx
          .select()
          .from(schema.holdingCoverage)
          .where(eq(schema.holdingCoverage.holdingId, holdingId));
        return [row?.firstTxAt ?? null, row?.lastTxAt ?? null];
      };
      expect(await boundsOf(elsewhere.id)).toEqual([T1, T1]);

      await ingest(payments(w), tx);

      expect(
        legsOf(await ledgerOf(tx, w.userId)).map((r) => [r.externalId, r.holdingId, r.inputId])
      ).toEqual([['out-1:mirror', opened!.id, w.inputId]]);
      expect([await boundsOf(elsewhere.id), await boundsOf(opened!.id)]).toEqual([
        [null, null],
        [T1, T1],
      ]);
    });
  });

  /**
   * R58's state in the feed account: `out-1` is the input's row on the
   * holding ingest created, and an imported holding the next run resolves to
   * holds an older copy of it with no input, an outflow "to savings" too.
   */
  async function copiedOutflow(tx: DatabaseTransaction, w: World) {
    await ingest(payments(w), tx);
    const [created] = await holdingsIn(tx, w.sourceAccountId);
    const imported = await makeHolding(tx, {
      userId: w.userId,
      accountId: w.sourceAccountId,
      tokenId: w.tokenId,
      externalId: `${w.symbol}-sync`,
      kind: 'feed',
    });
    await tx.insert(schema.holdingTransactions).values({
      userId: w.userId,
      holdingId: imported.id,
      tokenId: w.tokenId,
      kind: 'withdraw',
      quantity: '-250',
      occurredAt: T1,
      source: SOURCE,
      externalId: 'out-1',
      description: 'To Savings',
      counterparty: 'Savings account',
      ledgerKind: 'outflow',
    });
    const names = new Map([
      [created!.id, 'input row'],
      [imported.id, 'copy'],
    ]);
    // `out-1` on both holdings, and every leg, with what classification wrote.
    return async () => {
      const rows = await ledgerOf(tx, w.userId);
      const inputRow = rows.find((r) => r.externalId === 'out-1' && r.inputId !== null)!;
      return {
        group: deterministicUuid(w.inputId, `mirror:${inputRow.id}`),
        outflows: rows
          .filter((r) => r.externalId === 'out-1')
          .map((r) => [names.get(r.holdingId), r.inputId, r.ledgerKind, r.transferGroupId])
          .sort((x, y) => String(x).localeCompare(String(y))),
        legs: legsOf(rows).map((r) => [r.externalId, r.transferGroupId]),
      };
    };
  }

  // R59: classification reads only rows that carry an input. The R58 copy is
  // never decided; the run decides the input's own row in its place, and the
  // next run finds nothing left to decide.
  test("an R58 copy is never classified: the input's own row is, and gets the one leg (R59)", async () => {
    await withTestDb(async (tx) => {
      const w = await world(tx, { rule: null });
      const state = await copiedOutflow(tx, w);
      await addRule(tx, w, TO_SAVINGS);

      await ingest(payments(w), tx);
      const decided = await state();
      await ingest(payments(w), tx);

      expect(decided).toEqual({
        group: decided.group,
        outflows: [
          ['copy', null, 'outflow', null],
          ['input row', w.inputId, 'transfer_out', decided.group],
        ],
        legs: [['out-1:mirror', decided.group]],
      });
      expect(await state()).toEqual(decided);
    });
  });

  // R59, the other half: the input's row already has its leg, and a copy
  // with no input cannot take it over.
  test('an R58 copy does not re-point the leg the input row already has (R59)', async () => {
    await withTestDb(async (tx) => {
      const w = await world(tx);
      const state = await copiedOutflow(tx, w);
      const before = await state();
      expect(before.legs).toEqual([['out-1:mirror', before.group]]);

      await ingest(payments(w), tx);

      expect(await state()).toEqual(before);
    });
  });

  test('a source row written again under a new id moves its leg to the new group, labels included', async () => {
    await withTestDb(async (tx) => {
      const w = await world(tx);
      await ingest(payments(w), tx);
      await tx
        .delete(schema.holdingTransactions)
        .where(
          and(
            eq(schema.holdingTransactions.userId, w.userId),
            eq(schema.holdingTransactions.externalId, 'out-1')
          )
        );
      await ingest(payments(w), tx);

      const rows = await ledgerOf(tx, w.userId);
      const source = rows.find((r) => r.externalId === 'out-1')!;
      const legs = legsOf(rows);
      const group = deterministicUuid(w.inputId, `mirror:${source.id}`);
      expect(legs.map((r) => [r.transferGroupId, r.groupId])).toEqual([[group, group]]);
      expect([source.transferGroupId, source.groupId]).toEqual([group, group]);
    });
  });
});

describe('a mirror leg, committed', () => {
  const createdUserIds: string[] = [];
  const createdInstitutionIds: string[] = [];
  const createdSymbols: string[] = [];

  afterEach(async () => {
    const db = getDb();
    const users = createdUserIds.splice(0);
    const institutions = createdInstitutionIds.splice(0);
    const symbols = createdSymbols.splice(0);
    if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
    if (symbols.length)
      await db.delete(schema.tokens).where(inArray(schema.tokens.symbol, symbols));
    if (institutions.length) {
      await db.delete(schema.institutions).where(inArray(schema.institutions.id, institutions));
    }
  });

  test('replaying the batch writes no second leg, changes no label and bumps no updated_at; the labels settle', async () => {
    const symbol = freshSymbol();
    createdSymbols.push(symbol);
    const w = await getDb().transaction(async (tx) => {
      const made = await world(tx, { symbol });
      createdUserIds.push(made.userId);
      createdInstitutionIds.push(made.sourceInstitutionId, made.savingsInstitutionId);
      return made;
    });
    const read = () =>
      getDb().transaction(async (tx) =>
        (await ledgerOf(tx, w.userId)).map((r) => ({
          externalId: r.externalId,
          ledgerKind: r.ledgerKind,
          groupId: r.groupId,
          transferGroupId: r.transferGroupId,
          kindOrigin: r.kindOrigin,
          updatedAt: r.updatedAt.toISOString(),
        }))
      );

    await ingest(payments(w));
    const first = await read();
    await ingest(payments(w));

    expect(first.map((r) => r.externalId)).toEqual(['out-1', 'out-1:mirror', 'out-2']);
    expect(await read()).toEqual(first);
    const balances = await getDb()
      .select({ balance: schema.holdings.balance })
      .from(schema.holdings)
      .where(and(eq(schema.holdings.accountId, w.savingsAccountId)));
    expect(balances).toEqual([{ balance: '250' }]);
    await expectLabelsSettled(w.userId);
  });

  test('a mirror pair cannot be unlinked: unlinking would leave the leg and its anchor with nothing to pair', async () => {
    const symbol = freshSymbol();
    createdSymbols.push(symbol);
    const w = await getDb().transaction(async (tx) => {
      const made = await world(tx, { symbol });
      createdUserIds.push(made.userId);
      createdInstitutionIds.push(made.sourceInstitutionId, made.savingsInstitutionId);
      return made;
    });
    await ingest(payments(w));
    const groupsOf = () =>
      getDb().transaction(async (tx) =>
        (await ledgerOf(tx, w.userId)).map((r) => [r.externalId, r.transferGroupId])
      );
    const before = await groupsOf();
    const source = await getDb().transaction(
      async (tx) => (await ledgerOf(tx, w.userId)).find((r) => r.externalId === 'out-1')!
    );

    expect(await Container.get(TransferReviewService).unlinkPair(w.userId, source.id)).toEqual({
      ok: false,
      reason: 'mirror',
    });
    expect(await groupsOf()).toEqual(before);
    expect(before.filter(([, group]) => group !== null)).toHaveLength(2);
  });
});

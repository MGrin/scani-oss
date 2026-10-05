import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { type DatabaseTransaction, getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { and, count, eq, isNotNull, or, sql } from 'drizzle-orm';
import { Container } from 'typedi';
import type { HoldingEvidence } from '../../../src/engine/types';
import { EngineEvidenceRepository } from '../../../src/repositories/EngineEvidenceRepository';
import { FeedInputRepository } from '../../../src/repositories/FeedInputRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import {
  type ClassificationReport,
  FoundationClassificationService,
  type StaleRelabelReport,
} from '../../../src/services/foundation/FoundationClassificationService';
import { classifyHoldingEvidence } from '../../../src/services/foundation/legacy-classification';
import { planFeedInputs } from '../../../src/services/foundation/plan-feed-inputs';
import { committedRows } from '../../../test/helpers/committed-rows';
import { commitExchange } from '../../../test/helpers/committed-seeds';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeInstitutionType, makeUser } from '../../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  makeToken,
} from '../../../test/helpers/factories-extra';
import {
  backendPid,
  latch,
  outcomeOf,
  settlesWithin,
  waitUntilBlocked,
} from '../../../test/helpers/lock-wait';

restoreContainerAfterAll();

const service = () => Container.get(FoundationClassificationService);
const at = (iso: string) => new Date(iso);
const NOTHING = { holdings: 0, observations: 0, entries: 0 };
const STATEMENT_WRITTEN = at('2026-02-01T09:00:00Z');
const FABRICATED_WRITTEN = at('2026-02-01T09:00:30Z');

type HoldingRow = typeof schema.holdings.$inferSelect;
type ObservationRow = typeof schema.holdingBalanceObservations.$inferSelect;
type EntryRow = typeof schema.holdingTransactions.$inferSelect;

interface Seeded {
  userId: string;
  walletId: string;
  wallet: {
    accountId: string;
    holding: HoldingRow;
    observation: ObservationRow;
    deposit: EntryRow;
  };
  manual: { holding: HoldingRow; observation: ObservationRow };
  statement: {
    accountId: string;
    holding: HoldingRow;
    close: ObservationRow;
    fabricated: ObservationRow;
    csvRow: EntryRow;
    opening: EntryRow;
  };
}

async function accountAt(tx: DatabaseTransaction, userId: string, metadata = {}) {
  const institution = await makeInstitution(tx);
  return makeAccount(tx, { userId, institutionId: institution.id, metadata });
}

async function holdingOn(
  tx: DatabaseTransaction,
  userId: string,
  accountId: string,
  source: string
) {
  return makeHolding(tx, { userId, accountId, tokenId: (await makeToken(tx)).id, source });
}

async function observe(
  tx: DatabaseTransaction,
  holding: HoldingRow,
  observedAt: Date,
  balance: string,
  fields: Partial<typeof schema.holdingBalanceObservations.$inferInsert> = {}
): Promise<ObservationRow> {
  const [row] = await tx
    .insert(schema.holdingBalanceObservations)
    .values({
      userId: holding.userId,
      holdingId: holding.id,
      balance,
      observedAt,
      source: 'sync-capture',
      ...fields,
    })
    .returning();
  return row!;
}

const origin = (value: string) => ({ sourceMetadata: { origin: value } });

function entry(
  tx: DatabaseTransaction,
  holding: HoldingRow,
  fields: Partial<typeof schema.holdingTransactions.$inferInsert>
): Promise<EntryRow> {
  return makeHoldingTransaction(tx, {
    userId: holding.userId,
    holdingId: holding.id,
    tokenId: holding.tokenId,
    ...fields,
  });
}

/**
 * A wallet account with a provider-synced `blockchain` holding and an
 * `etherscan` deposit; a manual holding with a typed value; and a statement
 * holding with its close, the file import's fabricated copy 30 s later, a
 * statement ledger row and an opening row.
 */
async function seed(tx: DatabaseTransaction): Promise<Seeded> {
  const user = await makeUser(tx);
  const [wallet] = await tx
    .insert(schema.userWallets)
    .values({
      userId: user.id,
      walletAddress: `0x${randomUUID().replace(/-/g, '')}`,
      isActive: true,
    })
    .returning();

  const walletAccount = await accountAt(tx, user.id, { chainId: 1, userWalletId: wallet!.id });
  const walletHolding = await holdingOn(tx, user.id, walletAccount.id, 'blockchain');
  const walletObservation = await observe(
    tx,
    walletHolding,
    at('2026-01-10T00:00:00Z'),
    '5',
    origin('updateHoldingBalanceWithEvent')
  );
  const deposit = await entry(tx, walletHolding, {
    kind: 'deposit',
    quantity: '5',
    source: 'etherscan',
    occurredAt: at('2026-01-05T00:00:00Z'),
  });

  const manualAccount = await accountAt(tx, user.id);
  const manualHolding = await holdingOn(tx, user.id, manualAccount.id, 'manual');
  const manualObservation = await observe(
    tx,
    manualHolding,
    at('2026-01-12T00:00:00Z'),
    '250',
    origin('updateHolding')
  );

  const statementAccount = await accountAt(tx, user.id);
  const statementHolding = await holdingOn(tx, user.id, statementAccount.id, 'manual');
  const close = await observe(tx, statementHolding, at('2026-01-31T00:00:00Z'), '100', {
    source: 'statement-close',
    createdAt: STATEMENT_WRITTEN,
  });
  const fabricated = await observe(tx, statementHolding, FABRICATED_WRITTEN, '100', {
    ...origin('updateHoldingBalance'),
    createdAt: FABRICATED_WRITTEN,
  });
  const csvRow = await entry(tx, statementHolding, {
    kind: 'deposit',
    quantity: '40',
    source: 'statement-csv',
    occurredAt: at('2026-01-15T00:00:00Z'),
    createdAt: STATEMENT_WRITTEN,
  });
  const opening = await entry(tx, statementHolding, {
    kind: 'opening_balance',
    quantity: '60',
    source: 'reconciliation-opening',
    externalId: 'opening_balance',
    occurredAt: at('2026-01-01T00:00:00Z'),
  });

  return {
    userId: user.id,
    walletId: wallet!.id,
    wallet: {
      accountId: walletAccount.id,
      holding: walletHolding,
      observation: walletObservation,
      deposit,
    },
    manual: { holding: manualHolding, observation: manualObservation },
    statement: {
      accountId: statementAccount.id,
      holding: statementHolding,
      close,
      fabricated,
      csvRow,
      opening,
    },
  };
}

/** The user's rows that carry any of the columns the foundation added. */
async function labelledRows(tx: DatabaseTransaction, userId: string) {
  const h = schema.holdings;
  const o = schema.holdingBalanceObservations;
  const t = schema.holdingTransactions;
  const counted = async (query: Promise<Array<{ n: number }>>) => (await query)[0]?.n ?? -1;
  return {
    holdings: await counted(
      tx
        .select({ n: count() })
        .from(h)
        .where(
          and(
            eq(h.userId, userId),
            or(
              isNotNull(h.kind),
              isNotNull(h.startsAt),
              isNotNull(h.valueBase),
              isNotNull(h.valuePricedAt)
            )
          )
        )
    ),
    observations: await counted(
      tx
        .select({ n: count() })
        .from(o)
        .where(
          and(
            eq(o.userId, userId),
            or(
              isNotNull(o.role),
              isNotNull(o.authority),
              isNotNull(o.inputId),
              isNotNull(o.cause),
              isNotNull(o.supersededAt)
            )
          )
        )
    ),
    entries: await counted(
      tx
        .select({ n: count() })
        .from(t)
        .where(
          and(
            eq(t.userId, userId),
            or(
              isNotNull(t.ledgerKind),
              isNotNull(t.kindSubtype),
              isNotNull(t.groupId),
              isNotNull(t.feeOf),
              isNotNull(t.inputId),
              isNotNull(t.executionPrice),
              isNotNull(t.executionPriceTokenId),
              isNotNull(t.kindOrigin),
              isNotNull(t.decisionId)
            )
          )
        )
    ),
  };
}

async function rowCounts(tx: DatabaseTransaction, userId: string) {
  const n = async (query: Promise<Array<{ n: number }>>) => (await query)[0]?.n ?? -1;
  return {
    holdings: await n(
      tx.select({ n: count() }).from(schema.holdings).where(eq(schema.holdings.userId, userId))
    ),
    observations: await n(
      tx
        .select({ n: count() })
        .from(schema.holdingBalanceObservations)
        .where(eq(schema.holdingBalanceObservations.userId, userId))
    ),
    entries: await n(
      tx
        .select({ n: count() })
        .from(schema.holdingTransactions)
        .where(eq(schema.holdingTransactions.userId, userId))
    ),
  };
}

const inputsOf = (tx: DatabaseTransaction, userId: string) =>
  tx.select().from(schema.feedInputs).where(eq(schema.feedInputs.userId, userId));

async function holdingRow(tx: DatabaseTransaction, id: string) {
  const [row] = await tx.select().from(schema.holdings).where(eq(schema.holdings.id, id));
  return row!;
}

async function observationRow(tx: DatabaseTransaction, id: string) {
  const [row] = await tx
    .select()
    .from(schema.holdingBalanceObservations)
    .where(eq(schema.holdingBalanceObservations.id, id));
  return row!;
}

async function entryRow(tx: DatabaseTransaction, id: string) {
  const [row] = await tx
    .select()
    .from(schema.holdingTransactions)
    .where(eq(schema.holdingTransactions.id, id));
  return row!;
}

/** What the read path gives: today's rows classified, persisted labels winning. */
async function readTimeEvidence(tx: DatabaseTransaction, userId: string) {
  const raw = await Container.get(EngineEvidenceRepository).findHoldingEvidence({ userId }, tx);
  return raw.map((r) => classifyHoldingEvidence(r).evidence);
}

const evidenceFor = (all: readonly HoldingEvidence[], holdingId: string) =>
  all.find((e) => e.holdingId === holdingId)!;

const SEEDED_NOTES = {
  'kind:K1': 1,
  'kind:K3': 1,
  'kind:K4': 1,
  'obs:O1': 1,
  'obs:O2': 1,
  'obs:O4': 1,
  'obs:O5': 1,
};

describe('FoundationClassificationService.classify', () => {
  test('a dry run writes nothing and reports what it would', async () => {
    await withTestDb(async (tx) => {
      const s = await seed(tx);

      const dry = await service().classify({ apply: false, userId: s.userId }, tx);

      expect(dry.inputsCreated).toBe(0);
      expect(dry.inputsPlanned).toBe(2);
      expect(dry.rowsUpdated).toEqual({ holdings: 3, observations: 3, entries: 2 });
      expect(dry.failedUsers).toEqual([]);
      expect(await labelledRows(tx, s.userId)).toEqual(NOTHING);
      expect(await inputsOf(tx, s.userId)).toEqual([]);

      // The control: the same reading sees labels once apply has written them,
      // and apply writes exactly what the dry run said it would.
      const applied = await service().classify({ apply: true, userId: s.userId }, tx);
      expect(await labelledRows(tx, s.userId)).toEqual(applied.rowsUpdated);
      expect(dry).toEqual({ ...applied, apply: false, inputsCreated: 0 });
    });
  });

  test('apply creates the inputs and fills the labels', async () => {
    await withTestDb(async (tx) => {
      const s = await seed(tx);

      const report = await service().classify({ apply: true, userId: s.userId }, tx);

      expect(report).toEqual({
        apply: true,
        users: 1,
        inputsPlanned: 2,
        inputsCreated: 2,
        inputsLinked: 0,
        holdings: { feed: 2, snapshot: 1 },
        notes: SEEDED_NOTES,
        excluded: { 'fabricated-observation': 1, 'opening-row': 1, 'legacy-correction-row': 0 },
        inputDedupCollisions: 0,
        rowsUpdated: { holdings: 3, observations: 3, entries: 2 },
        failedUsers: [],
      });

      const inputs = await inputsOf(tx, s.userId);
      expect(
        inputs
          .map((i) => ({ accountId: i.accountId, source: i.source, walletId: i.walletId }))
          .sort((a, b) => a.source.localeCompare(b.source))
      ).toEqual([
        { accountId: s.wallet.accountId, source: 'etherscan', walletId: s.walletId },
        { accountId: s.statement.accountId, source: 'statement', walletId: null },
      ]);
      const etherscan = inputs.find((i) => i.source === 'etherscan')!;

      expect((await holdingRow(tx, s.wallet.holding.id)).kind).toBe('feed');
      const providerObservation = await observationRow(tx, s.wallet.observation.id);
      expect({
        role: providerObservation.role,
        authority: providerObservation.authority,
        inputId: providerObservation.inputId,
      }).toEqual({ role: 'checkpoint', authority: 'provider', inputId: etherscan.id });

      const deposit = await entryRow(tx, s.wallet.deposit.id);
      expect({
        ledgerKind: deposit.ledgerKind,
        kindOrigin: deposit.kindOrigin,
        inputId: deposit.inputId,
      }).toEqual({ ledgerKind: 'inflow', kindOrigin: 'source', inputId: etherscan.id });

      expect((await holdingRow(tx, s.manual.holding.id)).kind).toBe('snapshot');
      const typed = await observationRow(tx, s.manual.observation.id);
      expect({
        role: typed.role,
        authority: typed.authority,
        inputId: typed.inputId,
        cause: typed.cause,
      }).toEqual({ role: 'snapshot', authority: 'person', inputId: null, cause: 'flow' });
    });
  });

  test('apply twice: the second run updates nothing', async () => {
    await withTestDb(async (tx) => {
      const s = await seed(tx);

      const first = await service().classify({ apply: true, userId: s.userId }, tx);
      const second = await service().classify({ apply: true, userId: s.userId }, tx);

      expect(second.rowsUpdated).toEqual(NOTHING);
      expect(second.inputsCreated).toBe(0);
      expect(second).toEqual({
        ...first,
        inputsPlanned: 0,
        inputsCreated: 0,
        rowsUpdated: NOTHING,
      });
      expect(await inputsOf(tx, s.userId)).toHaveLength(2);
      // A dry run now finds the inputs that exist, and nothing left to write.
      const dry = await service().classify({ apply: false, userId: s.userId }, tx);
      expect(dry).toEqual({ ...second, apply: false });
    });
  });

  // Ingest creates its input active and naming no credential or wallet, and
  // nothing links it until the account's next connect, disconnect or import
  // (R94). Apply brings it up to the account's connection, as those do.
  test('apply links an input ingest created unlinked, and a second apply changes nothing', async () => {
    await withTestDb(async (tx) => {
      const s = await seed(tx);
      const created = await Container.get(FeedInputRepository).findOrCreate(
        {
          userId: s.userId,
          accountId: s.wallet.accountId,
          source: 'etherscan',
          credentialId: null,
          walletId: null,
        },
        tx
      );
      expect({ walletId: created.walletId, status: created.status }).toEqual({
        walletId: null,
        status: 'active',
      });

      const first = await service().classify({ apply: true, userId: s.userId }, tx);

      // The statement input is the one apply had left to create.
      expect({ created: first.inputsCreated, linked: first.inputsLinked }).toEqual({
        created: 1,
        linked: 1,
      });
      const linked = (await inputsOf(tx, s.userId)).find((i) => i.id === created.id);
      expect({
        walletId: linked?.walletId,
        credentialId: linked?.credentialId,
        status: linked?.status,
      }).toEqual({ walletId: s.walletId, credentialId: null, status: 'active' });

      const afterFirst = await inputsOf(tx, s.userId);
      const second = await service().classify({ apply: true, userId: s.userId }, tx);
      expect({ created: second.inputsCreated, linked: second.inputsLinked }).toEqual({
        created: 0,
        linked: 0,
      });
      expect(await inputsOf(tx, s.userId)).toEqual(afterFirst);
    });
  });

  test("apply gives an input whose wallet was switched off its connection's status, and a dry run counts that link without writing it", async () => {
    await withTestDb(async (tx) => {
      const s = await seed(tx);
      const created = await Container.get(FeedInputRepository).findOrCreate(
        {
          userId: s.userId,
          accountId: s.wallet.accountId,
          source: 'etherscan',
          credentialId: null,
          walletId: null,
        },
        tx
      );
      await tx
        .update(schema.userWallets)
        .set({ isActive: false })
        .where(eq(schema.userWallets.id, s.walletId));

      const dry = await service().classify({ apply: false, userId: s.userId }, tx);
      expect(dry.inputsLinked).toBe(1);
      expect((await inputsOf(tx, s.userId)).find((i) => i.id === created.id)).toEqual(created);

      const applied = await service().classify({ apply: true, userId: s.userId }, tx);
      expect(applied.inputsLinked).toBe(1);
      const followed = (await inputsOf(tx, s.userId)).find((i) => i.id === created.id);
      expect({ walletId: followed?.walletId, status: followed?.status }).toEqual({
        walletId: s.walletId,
        status: 'disconnected',
      });
      // The control: with the input current, a dry run has no link left to count.
      const settled = await service().classify({ apply: false, userId: s.userId }, tx);
      expect(settled.inputsLinked).toBe(0);
    });
  });

  // An input apply would create is created with its connection, so it is not
  // a link to count: only one that exists and is behind its account's is.
  test('a dry run counts the links apply writes, input for input', async () => {
    await withTestDb(async (tx) => {
      const s = await seed(tx);
      await Container.get(FeedInputRepository).findOrCreate(
        {
          userId: s.userId,
          accountId: s.wallet.accountId,
          source: 'etherscan',
          credentialId: null,
          walletId: null,
        },
        tx
      );

      const dry = await service().classify({ apply: false, userId: s.userId }, tx);
      const applied = await service().classify({ apply: true, userId: s.userId }, tx);

      // The statement input is the one apply creates; the wallet's is the one it links.
      expect({ created: applied.inputsCreated, linked: applied.inputsLinked }).toEqual({
        created: 1,
        linked: 1,
      });
      expect(dry).toEqual({ ...applied, apply: false, inputsCreated: 0 });
    });
  });

  test('a dry run works in a read-only session, which apply cannot', async () => {
    await withTestDb(async (tx) => {
      const s = await seed(tx);
      // What an operator script run without --apply gets from `@scani/db`.
      await tx.execute(sql`SET TRANSACTION READ ONLY`);

      const dry = await service().classify({ apply: false, userId: s.userId }, tx);

      expect(dry.failedUsers).toEqual([]);
      expect(dry.inputsPlanned).toBe(2);
      expect(dry.rowsUpdated).toEqual({ holdings: 3, observations: 3, entries: 2 });
      // The control: the session really refuses writes, and says so in one line.
      const svc = service();
      const { result: applied, errors } = await capturingErrors(svc, () =>
        svc.classify({ apply: true, userId: s.userId }, tx)
      );
      expect(applied.failedUsers).toEqual([
        { userId: s.userId, error: 'cannot execute INSERT in a read-only transaction' },
      ]);
      const [context] = errors[0] ?? [];
      const { err } = context as { err: { code?: string; cause?: { code?: string } } };
      expect(err.cause?.code ?? err.code).toBe('25006');
    });
  });

  test('with no transaction given, a dry run reads one read-only snapshot and apply writes', async () => {
    // A user with no rows: neither mode has anything to write, so this may run
    // outside a test transaction. The settings are read inside the transaction
    // the service hands its first repository call.
    const feedInputs = Container.get(FeedInputRepository);
    const seen: Array<{ readOnly: string; isolation: string }> = [];
    const facts = spyOn(feedInputs, 'findAccountInputFacts').mockImplementation(
      async (_userId, tx) => {
        if (tx === undefined) throw new Error('the service handed no transaction');
        const [row] = (await tx.execute(
          sql`SELECT current_setting('transaction_read_only') AS "readOnly",
                     current_setting('transaction_isolation') AS isolation`
        )) as unknown as Array<{ readOnly: string; isolation: string }>;
        if (row) seen.push(row);
        return [];
      }
    );
    try {
      const dry = await service().classify({ apply: false, userId: randomUUID() });
      const applied = await service().classify({ apply: true, userId: randomUUID() });
      expect([dry.failedUsers, applied.failedUsers]).toEqual([[], []]);
    } finally {
      facts.mockRestore();
    }

    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ readOnly: 'on', isolation: 'repeatable read' });
    expect(seen[1]?.readOnly).toBe('off');
  });

  test('a label someone already set survives', async () => {
    await withTestDb(async (tx) => {
      const s = await seed(tx);
      await tx
        .update(schema.holdingTransactions)
        .set({ ledgerKind: 'outflow' })
        .where(eq(schema.holdingTransactions.id, s.wallet.deposit.id));

      const dry = await service().classify({ apply: false, userId: s.userId }, tx);
      const applied = await service().classify({ apply: true, userId: s.userId }, tx);

      const deposit = await entryRow(tx, s.wallet.deposit.id);
      expect(deposit.ledgerKind).toBe('outflow');
      // Only what the persisted kind leaves open is filled: its input, never an origin.
      expect(deposit.kindOrigin).toBeNull();
      expect(deposit.inputId).not.toBeNull();
      // The deposit's only label is the input apply creates, so the dry run must
      // count it through the input it holds in memory.
      expect(dry.rowsUpdated).toEqual(applied.rowsUpdated);
    });
  });

  test('fabricated observations and opening rows are kept, unlabelled', async () => {
    await withTestDb(async (tx) => {
      const s = await seed(tx);
      const before = await rowCounts(tx, s.userId);

      const report = await service().classify({ apply: true, userId: s.userId }, tx);

      expect(await rowCounts(tx, s.userId)).toEqual(before);
      expect(before).toEqual({ holdings: 3, observations: 4, entries: 3 });
      const fabricated = await observationRow(tx, s.statement.fabricated.id);
      expect(fabricated.role).toBeNull();
      expect(fabricated.authority).toBeNull();
      expect(fabricated.inputId).toBeNull();
      const opening = await entryRow(tx, s.statement.opening.id);
      expect(opening.ledgerKind).toBeNull();
      expect(opening.inputId).toBeNull();
      expect(opening.kindOrigin).toBeNull();
      // The control: their neighbours were labelled in the same run.
      expect((await observationRow(tx, s.statement.close.id)).role).toBe('checkpoint');
      expect((await entryRow(tx, s.statement.csvRow.id)).ledgerKind).toBe('inflow');
      expect(report.excluded).toEqual({
        'fabricated-observation': 1,
        'opening-row': 1,
        'legacy-correction-row': 0,
      });
    });
  });

  test('entries sharing an external id within one input are counted, across holdings', async () => {
    await withTestDb(async (tx) => {
      const s = await seed(tx);
      // A swap's two legs on two holdings of one wallet carry one tx hash.
      const otherLeg = await holdingOn(tx, s.userId, s.wallet.accountId, 'blockchain');
      const hash = `0x${randomUUID().replace(/-/g, '')}`;
      await entry(tx, s.wallet.holding, {
        kind: 'swap_out',
        quantity: '-1',
        source: 'etherscan',
        externalId: hash,
      });
      await entry(tx, otherLeg, {
        kind: 'swap_in',
        quantity: '3',
        source: 'etherscan',
        externalId: hash,
      });
      // The same id under another input is no collision.
      await entry(tx, s.statement.holding, {
        kind: 'deposit',
        quantity: '1',
        source: 'statement-csv',
        externalId: hash,
      });

      const report = await service().classify({ apply: false, userId: s.userId }, tx);

      expect(report.inputDedupCollisions).toBe(2);
    });
  });

  test('REVIEW FOCUS 3: read-time classification equals the backfill', async () => {
    await withTestDb(async (tx) => {
      const s = await seed(tx);
      // Inputs first: until they exist no row can name one, at read time or in the backfill.
      const feedInputs = Container.get(FeedInputRepository);
      const facts = await feedInputs.findAccountInputFacts(s.userId, tx);
      await feedInputs.insertMissing(
        facts.flatMap((f) => planFeedInputs(f)),
        tx
      );
      const readBefore = await readTimeEvidence(tx, s.userId);

      await service().classify({ apply: true, userId: s.userId }, tx);

      expect(await readTimeEvidence(tx, s.userId)).toEqual(readBefore);

      // Today's writers add rows after the backfill: a provider sync, a typed value
      // on the now-feed holding, and a chain deposit.
      const synced = await observe(
        tx,
        s.wallet.holding,
        at('2026-02-10T00:00:00Z'),
        '7',
        origin('updateHoldingBalanceWithEvent')
      );
      const typed = await observe(
        tx,
        s.wallet.holding,
        at('2026-02-11T00:00:00Z'),
        '7',
        origin('updateHolding')
      );
      const deposit = await entry(tx, s.wallet.holding, {
        kind: 'deposit',
        quantity: '2',
        source: 'etherscan',
        occurredAt: at('2026-02-09T00:00:00Z'),
      });
      const readLater = await readTimeEvidence(tx, s.userId);

      const second = await service().classify({ apply: true, userId: s.userId }, tx);

      expect(second.rowsUpdated).toEqual({ holdings: 0, observations: 2, entries: 1 });
      expect(await readTimeEvidence(tx, s.userId)).toEqual(readLater);

      const wallet = evidenceFor(readLater, s.wallet.holding.id);
      for (const row of [synced, typed]) {
        const read = wallet.observations.find((o) => o.id === row.id)!;
        const stored = await observationRow(tx, row.id);
        expect({
          role: stored.role,
          authority: stored.authority,
          inputId: stored.inputId,
          cause: stored.cause,
        }).toEqual({
          role: read.role,
          authority: read.authority,
          inputId: read.inputId,
          cause: read.cause,
        });
      }
      expect(wallet.observations.find((o) => o.id === typed.id)?.role).toBe('verification');
      const readDeposit = wallet.entries.find((e) => e.id === deposit.id)!;
      const storedDeposit = await entryRow(tx, deposit.id);
      expect({
        kind: storedDeposit.ledgerKind,
        kindOrigin: storedDeposit.kindOrigin,
        inputId: storedDeposit.inputId,
      }).toEqual({
        kind: readDeposit.kind,
        kindOrigin: readDeposit.kindOrigin,
        inputId: readDeposit.inputId,
      });
    });
  });
});

/**
 * The real repository, except that it names the users to run and refuses one
 * user's evidence read: both modes make it, and apply makes it after the inputs
 * are inserted, so the rollback has a write to undo.
 */
class RefusesOneUser extends EngineEvidenceRepository {
  private readonly runUsers: readonly string[];
  private readonly refused: string;

  constructor(runUsers: readonly string[], refused: string) {
    super();
    this.runUsers = runUsers;
    this.refused = refused;
  }

  override async findUsersWithHoldings() {
    return this.runUsers.map((userId) => ({ userId, baseCurrencyId: null }));
  }

  override async findHoldingEvidence(
    scope: { userId: string; holdingIds?: readonly string[] },
    tx?: DatabaseTransaction
  ) {
    if (scope.userId === this.refused) throw new Error(`evidence refused for ${scope.userId}`);
    return super.findHoldingEvidence(scope, tx);
  }
}

/** One user's stale labels, through the real service. */
async function staleOf(userId: string, tx?: DatabaseTransaction) {
  return (await service().listStaleLabels({ userId }, tx)).stale;
}

describe('FoundationClassificationService.listStaleLabels', () => {
  test('lists each ledger label its row has moved away from, and writes nothing', async () => {
    await withTestDb(async (tx) => {
      const s = await seed(tx);
      await service().classify({ apply: true, userId: s.userId }, tx);
      const t = schema.holdingTransactions;
      // Paired after it was labelled, by a writer that did not re-label: the
      // deposit's label still says `inflow`.
      const groupId = randomUUID();
      const pairedAt = at('2026-03-01T00:00:00Z');
      await tx
        .update(t)
        .set({ transferGroupId: groupId, updatedAt: pairedAt })
        .where(eq(t.id, s.wallet.deposit.id));
      // Rewritten into a correction after it was labelled: a row the mapping
      // now excludes, still carrying the label of the deposit it was.
      const rewrittenAt = at('2026-02-20T00:00:00Z');
      await tx
        .update(t)
        .set({ kind: 'correction', updatedAt: rewrittenAt })
        .where(eq(t.id, s.statement.csvRow.id));
      const stored = await tx.select().from(t).where(eq(t.userId, s.userId)).orderBy(t.id);

      const listed = await service().listStaleLabels({ userId: s.userId }, tx);

      expect({ users: listed.users, failedUsers: listed.failedUsers }).toEqual({
        users: 1,
        failedUsers: [],
      });
      expect(listed.stale).toEqual([
        {
          userId: s.userId,
          entryId: s.statement.csvRow.id,
          holdingId: s.statement.holding.id,
          source: 'statement-csv',
          legacyKind: 'correction',
          storedKind: 'inflow',
          kindOrigin: 'source',
          derivedKind: 'excluded:legacy-correction-row',
          differs: ['ledgerKind'],
          transferGroupId: null,
          updatedAt: rewrittenAt,
        },
        {
          userId: s.userId,
          entryId: s.wallet.deposit.id,
          holdingId: s.wallet.holding.id,
          source: 'etherscan',
          legacyKind: 'deposit',
          storedKind: 'inflow',
          kindOrigin: 'source',
          derivedKind: 'transfer_in',
          differs: ['ledgerKind', 'groupId'],
          transferGroupId: groupId,
          updatedAt: pairedAt,
        },
      ]);
      // The list is the rows the dry run's note counts.
      const dry = await service().classify({ apply: false, userId: s.userId }, tx);
      expect(dry.notes['stale-label']).toBe(2);
      expect(await tx.select().from(t).where(eq(t.userId, s.userId)).orderBy(t.id)).toEqual(stored);
    });
  });

  test('a label a rule wrote is never listed, and a settled ledger lists nothing', async () => {
    await withTestDb(async (tx) => {
      const s = await seed(tx);
      await service().classify({ apply: true, userId: s.userId }, tx);
      expect(await staleOf(s.userId, tx)).toEqual([]);

      // The same disagreement as a stale label, on a label the mapping cannot
      // re-derive: a classification result, which nothing has moved away from.
      await tx
        .update(schema.holdingTransactions)
        .set({ ledgerKind: 'transfer_in', kindOrigin: 'rule' })
        .where(eq(schema.holdingTransactions.id, s.wallet.deposit.id));

      expect(await staleOf(s.userId, tx)).toEqual([]);
    });
  });

  test('with no user named it covers every user with a holding', async () => {
    await withTestDb(async (tx) => {
      const first = await seed(tx);
      const second = await seed(tx);
      await service().classify({ apply: true }, tx);
      for (const s of [first, second]) {
        await tx
          .update(schema.holdingTransactions)
          .set({ transferGroupId: randomUUID() })
          .where(eq(schema.holdingTransactions.id, s.wallet.deposit.id));
      }

      const { stale: listed } = await service().listStaleLabels({}, tx);

      expect(listed.map((label) => label.entryId).sort()).toEqual(
        [first.wallet.deposit.id, second.wallet.deposit.id].sort()
      );
    });
  });

  test('a user whose read throws is listed as failed, and the others are still listed', async () => {
    await withTestDb(async (tx) => {
      const failing = await staleSeed(tx);
      const passing = await staleSeed(tx);
      const passingLabels = await staleOf(passing.s.userId, tx);
      // The failing user runs first, so the listing has to go on past it.
      const users = [failing.s.userId, passing.s.userId];

      const over = serviceOver(new RefusesOneUser(users, failing.s.userId));
      const { result: list, errors } = await capturingErrors(over, () =>
        over.listStaleLabels({}, tx)
      );

      expect(passingLabels).toHaveLength(2);
      expect(list).toEqual({
        users: 2,
        stale: passingLabels,
        failedUsers: [
          { userId: failing.s.userId, error: `evidence refused for ${failing.s.userId}` },
        ],
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.[0]).toMatchObject({ userId: failing.s.userId });
    });
  });
});

/** A service built over `repository`, with the container put back at once. */
function serviceOver(repository: EngineEvidenceRepository): FoundationClassificationService {
  const real = Container.get(EngineEvidenceRepository);
  Container.set(EngineEvidenceRepository, repository);
  try {
    return new FoundationClassificationService();
  } finally {
    Container.set(EngineEvidenceRepository, real);
  }
}

/**
 * Runs `run` with the service's error log captured, so a deliberate failure is
 * asserted rather than printed into a green run. The calls are copied before
 * the restore, which clears them.
 */
async function capturingErrors<T>(
  service: FoundationClassificationService,
  run: () => Promise<T>
): Promise<{ result: T; errors: unknown[][] }> {
  // `logger` is private so the service owns its component name.
  const { logger } = service as unknown as {
    logger: { error: (context: unknown, message: string) => void };
  };
  const logged = spyOn(logger, 'error').mockImplementation(() => {});
  try {
    const result = await run();
    return { result, errors: logged.mock.calls.map((call) => [...call]) };
  } finally {
    logged.mockRestore();
  }
}

describe('a user that throws', () => {
  for (const apply of [true, false]) {
    test(`is rolled back and listed, and the run continues (apply: ${apply})`, async () => {
      await withTestDb(async (tx) => {
        const failing = await seed(tx);
        const passing = await seed(tx);
        // The failing user runs first, so the run has to go on past it.
        const users = [failing.userId, passing.userId];

        const service = serviceOver(new RefusesOneUser(users, failing.userId));
        const { result: report, errors } = await capturingErrors(service, () =>
          service.classify({ apply }, tx)
        );

        expect(errors).toHaveLength(1);
        const [context] = errors[0] ?? [];
        expect(context).toMatchObject({ userId: failing.userId });
        expect((context as { err?: Error }).err?.message).toBe(
          `evidence refused for ${failing.userId}`
        );
        expect(report.users).toBe(2);
        expect(report.failedUsers).toEqual([
          { userId: failing.userId, error: `evidence refused for ${failing.userId}` },
        ]);
        // Counts cover the user that did not fail.
        expect(report.inputsPlanned).toBe(2);
        expect(report.inputsCreated).toBe(apply ? 2 : 0);
        expect(report.rowsUpdated).toEqual({ holdings: 3, observations: 3, entries: 2 });
        expect(report.notes).toEqual(SEEDED_NOTES);

        // Its inputs were inserted before the throw, and went with the rollback.
        expect(await inputsOf(tx, failing.userId)).toEqual([]);
        expect(await labelledRows(tx, failing.userId)).toEqual(NOTHING);
        expect(await inputsOf(tx, passing.userId)).toHaveLength(apply ? 2 : 0);
        expect(await labelledRows(tx, passing.userId)).toEqual(
          apply ? { holdings: 3, observations: 3, entries: 2 } : NOTHING
        );
      });
    });
  }
});

/**
 * R98. `relabelStaleLabels` closes what `listStaleLabels` lists, through
 * `relabelEntries`: the D-5 overwrite, which leaves a decision and a rule,
 * mirror or Jev label alone.
 */

const ledger = schema.holdingTransactions;

/**
 * The seed and a trade leg, classified; then the deposit paired and the leg
 * grouped with nothing re-labelling either, and the statement row's label
 * replaced by a rule's.
 */
async function staleSeed(tx: DatabaseTransaction) {
  const s = await seed(tx);
  const leg = await entry(tx, s.wallet.holding, {
    kind: 'swap_in',
    quantity: '2',
    source: 'etherscan',
    occurredAt: at('2026-01-06T00:00:00Z'),
  });
  await service().classify({ apply: true, userId: s.userId }, tx);
  const swapGroupId = randomUUID();
  const transferGroupId = randomUUID();
  await tx
    .update(ledger)
    .set({ swapGroupId, updatedAt: at('2026-02-20T00:00:00Z') })
    .where(eq(ledger.id, leg.id));
  await tx
    .update(ledger)
    .set({ transferGroupId, updatedAt: at('2026-03-01T00:00:00Z') })
    .where(eq(ledger.id, s.wallet.deposit.id));
  await tx
    .update(ledger)
    .set({ ledgerKind: 'transfer_in', kindOrigin: 'rule' })
    .where(eq(ledger.id, s.statement.csvRow.id));
  return { s, leg, swapGroupId, transferGroupId };
}

const ledgerRowsOf = (tx: DatabaseTransaction, userId: string) =>
  tx.select().from(ledger).where(eq(ledger.userId, userId)).orderBy(ledger.id);

async function labelOf(tx: DatabaseTransaction, id: string) {
  const row = await entryRow(tx, id);
  return { ledgerKind: row.ledgerKind, groupId: row.groupId, kindOrigin: row.kindOrigin };
}

describe('FoundationClassificationService.relabelStaleLabels', () => {
  test('re-labels a paired row and a trade leg whose labels went stale, and nothing is stale afterwards', async () => {
    await withTestDb(async (tx) => {
      const { s, leg, swapGroupId, transferGroupId } = await staleSeed(tx);
      const listed = await staleOf(s.userId, tx);
      // The control: these two are what is stale, each for the fact that moved.
      expect(
        listed.map((label) => [label.entryId, label.storedKind, label.derivedKind, label.differs])
      ).toEqual([
        [leg.id, 'trade_leg', 'trade_leg', ['groupId']],
        [s.wallet.deposit.id, 'inflow', 'transfer_in', ['ledgerKind', 'groupId']],
      ]);

      const report = await service().relabelStaleLabels({ apply: true, userId: s.userId }, tx);

      expect(report).toEqual({
        apply: true,
        users: 1,
        relabelled: 2,
        held: listed,
        stale: [],
        failedUsers: [],
      });
      expect(await staleOf(s.userId, tx)).toEqual([]);
      expect(await labelOf(tx, leg.id)).toEqual({
        ledgerKind: 'trade_leg',
        groupId: swapGroupId,
        kindOrigin: 'source',
      });
      expect(await labelOf(tx, s.wallet.deposit.id)).toEqual({
        ledgerKind: 'transfer_in',
        groupId: transferGroupId,
        kindOrigin: 'source',
      });
    });
  });

  test("leaves a rule's label as it is, though it disagrees with the mapping as a stale one does", async () => {
    await withTestDb(async (tx) => {
      const { s } = await staleSeed(tx);
      const ruled = await entryRow(tx, s.statement.csvRow.id);
      // The control: the mapping gives this row `inflow`, and the rule's label says otherwise.
      expect([ruled.kind, ruled.ledgerKind, ruled.kindOrigin]).toEqual([
        'deposit',
        'transfer_in',
        'rule',
      ]);

      const report = await service().relabelStaleLabels({ apply: true, userId: s.userId }, tx);

      expect({ relabelled: report.relabelled, held: report.held.length }).toEqual({
        relabelled: 2,
        held: 2,
      });
      expect(await entryRow(tx, s.statement.csvRow.id)).toEqual(ruled);
    });
  });

  test('a second run changes nothing', async () => {
    await withTestDb(async (tx) => {
      const { s } = await staleSeed(tx);
      await service().relabelStaleLabels({ apply: true, userId: s.userId }, tx);
      const settled = await ledgerRowsOf(tx, s.userId);

      const second = await service().relabelStaleLabels({ apply: true, userId: s.userId }, tx);

      expect(second).toEqual({
        apply: true,
        users: 1,
        relabelled: 0,
        held: [],
        stale: [],
        failedUsers: [],
      });
      expect(await ledgerRowsOf(tx, s.userId)).toEqual(settled);
    });
  });

  // SC-1539. A price is text in both columns, and the listing and the write both
  // compare it as text: a label holding another spelling of the same number is
  // listed, re-written to the row's own spelling, and not listed again. Were the
  // write to compare it as a number, the label would be listed for ever and an
  // apply would exit 2 every run.
  test('a price label in another text form of the same number is re-written, then not listed', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const type = await makeInstitutionType(tx, { code: 'crypto_exchange' });
      const institution = await makeInstitution(tx, { typeId: type.id });
      const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const token = await makeToken(tx);
      const holding = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
      });
      const leg = await entry(tx, holding, {
        kind: 'buy',
        quantity: '2',
        source: 'kraken',
        priceNative: '1.50',
        ledgerKind: 'trade_leg',
        kindOrigin: 'source',
        executionPrice: '1.5',
      });
      // A buy with no swap or settle group is its own group.
      await tx.update(ledger).set({ groupId: leg.id }).where(eq(ledger.id, leg.id));

      const listed = await staleOf(user.id, tx);
      // The control: only the price's spelling differs.
      expect(listed.map((label) => [label.entryId, label.differs])).toEqual([
        [leg.id, ['executionPrice']],
      ]);

      const report = await service().relabelStaleLabels({ apply: true, userId: user.id }, tx);

      expect({ relabelled: report.relabelled, stale: report.stale }).toEqual({
        relabelled: 1,
        stale: [],
      });
      expect((await entryRow(tx, leg.id)).executionPrice).toBe('1.50');
      expect(await staleOf(user.id, tx)).toEqual([]);
    });
  });

  test('a dry run writes nothing, and reports the stale list as it read it', async () => {
    await withTestDb(async (tx) => {
      const { s } = await staleSeed(tx);
      const listed = await staleOf(s.userId, tx);
      const stored = await ledgerRowsOf(tx, s.userId);

      const report = await service().relabelStaleLabels({ apply: false, userId: s.userId }, tx);

      expect(listed).toHaveLength(2);
      expect(report).toEqual({
        apply: false,
        users: 1,
        relabelled: 0,
        held: [],
        stale: listed,
        failedUsers: [],
      });
      expect(await ledgerRowsOf(tx, s.userId)).toEqual(stored);
    });
  });

  test('a dry run lists a user whose read throws as failed, and reports the others', async () => {
    await withTestDb(async (tx) => {
      const failing = await staleSeed(tx);
      const passing = await staleSeed(tx);
      const passingLabels = await staleOf(passing.s.userId, tx);
      // The failing user runs first, so the run has to go on past it.
      const users = [failing.s.userId, passing.s.userId];

      const over = serviceOver(new RefusesOneUser(users, failing.s.userId));
      const { result: report, errors } = await capturingErrors(over, () =>
        over.relabelStaleLabels({ apply: false }, tx)
      );

      expect(passingLabels).toHaveLength(2);
      expect(report).toEqual({
        apply: false,
        users: 2,
        relabelled: 0,
        held: [],
        stale: passingLabels,
        failedUsers: [
          { userId: failing.s.userId, error: `evidence refused for ${failing.s.userId}` },
        ],
      });
      expect(errors).toHaveLength(1);
    });
  });

  test('with no user named it covers every user, each in a transaction of its own: one that throws after its write is rolled back and listed', async () => {
    await withTestDb(async (tx) => {
      const failing = await staleSeed(tx);
      const passing = await staleSeed(tx);
      // The failing user runs first, so the run has to go on past it.
      const users = [failing.s.userId, passing.s.userId];
      const passingLabels = await staleOf(passing.s.userId, tx);
      const failingRows = await ledgerRowsOf(tx, failing.s.userId);

      const over = serviceOver(new RefusesTheReadAfterTheWrite(users, failing.s.userId));
      const { result: report, errors } = await capturingErrors(over, () =>
        over.relabelStaleLabels({ apply: true }, tx)
      );

      expect(errors).toHaveLength(1);
      expect(errors[0]?.[0]).toMatchObject({ userId: failing.s.userId });
      expect(report).toEqual({
        apply: true,
        users: 2,
        relabelled: 2,
        held: passingLabels,
        stale: [],
        failedUsers: [
          {
            userId: failing.s.userId,
            error: `read after the write refused for ${failing.s.userId}`,
          },
        ],
      });
      // Its re-label was written before the throw, and went with the rollback.
      expect(await ledgerRowsOf(tx, failing.s.userId)).toEqual(failingRows);
      expect(await staleOf(failing.s.userId, tx)).toHaveLength(2);
      expect(await staleOf(passing.s.userId, tx)).toEqual([]);
    });
  });
});

/**
 * The real repository, except that it names the users to run and refuses one
 * user's third evidence read: the one a re-label makes after its write, the
 * first two being its listing and its listing again once the rows are held.
 * So the rollback has a write to undo.
 */
class RefusesTheReadAfterTheWrite extends EngineEvidenceRepository {
  private readonly runUsers: readonly string[];
  private readonly refused: string;
  private reads = 0;

  constructor(runUsers: readonly string[], refused: string) {
    super();
    this.runUsers = runUsers;
    this.refused = refused;
  }

  override async findUsersWithHoldings() {
    return this.runUsers.map((userId) => ({ userId, baseCurrencyId: null }));
  }

  override async findHoldingEvidence(
    scope: { userId: string; holdingIds?: readonly string[] },
    tx?: DatabaseTransaction
  ) {
    if (scope.userId === this.refused) {
      this.reads += 1;
      if (this.reads === 3) {
        throw new Error(`read after the write refused for ${scope.userId}`);
      }
    }
    return super.findHoldingEvidence(scope, tx);
  }
}

/** The real repository, except that it names the users to run. */
class NamesTheUsers extends EngineEvidenceRepository {
  private readonly runUsers: readonly string[];

  constructor(runUsers: readonly string[]) {
    super();
    this.runUsers = runUsers;
  }

  override async findUsersWithHoldings() {
    return this.runUsers.map((userId) => ({ userId, baseCurrencyId: null }));
  }
}

/** A user's inputs and holding kinds as committed, which is what a second transaction left. */
async function committedState(userId: string) {
  const inputs = await getDb()
    .select({ credentialId: schema.feedInputs.credentialId, status: schema.feedInputs.status })
    .from(schema.feedInputs)
    .where(eq(schema.feedInputs.userId, userId));
  const holdings = await getDb()
    .select({ kind: schema.holdings.kind })
    .from(schema.holdings)
    .where(eq(schema.holdings.userId, userId));
  return { inputs, kinds: holdings.map((h) => h.kind) };
}

/**
 * An ingest holds its input FOR NO KEY UPDATE for its whole run, and apply
 * links a user's inputs across accounts in one transaction (R100 m1). Apply
 * gives a user up 5s behind such a lock, the foundation migrations' bound,
 * rather than at the session's statement timeout. The rows are committed: a
 * lock needs a second transaction to be seen.
 */
describe('classify apply beside an ingest that holds a feed input', () => {
  const rows = committedRows();
  const spies: Array<{ mockRestore(): void }> = [];
  afterEach(async () => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    await rows.drop();
  });

  test('gives that user up at its lock timeout and lists it, classifies the next user, and a re-run succeeds', async () => {
    const waiting = await commitExchange(rows, { evidence: true, connected: true });
    const passing = await commitExchange(rows, { evidence: true, connected: true });
    const repo = Container.get(FeedInputRepository);
    // The input as an ingest creates it: naming no credential, so apply has a link to write.
    const input = {
      userId: waiting.userId,
      accountId: waiting.account.id,
      source: waiting.source,
      credentialId: null,
      walletId: null,
    };
    await getDb().transaction((tx) => repo.findOrCreate(input, tx));

    const held = latch();
    const release = latch();
    let holderPid: number | undefined;
    const holder = getDb().transaction(async (tx) => {
      holderPid = await backendPid(tx);
      await repo.findOrCreate(input, tx);
      held.open();
      await release.passed;
    });

    let applyPid: number | undefined;
    const linkAndSetStatus = repo.linkAndSetStatus.bind(repo);
    spies.push(
      spyOn(repo, 'linkAndSetStatus').mockImplementation(async (planned, tx) => {
        applyPid ??= await backendPid(tx);
        return await linkAndSetStatus(planned, tx);
      })
    );
    // The waiting user runs first, so the run has to go on past it.
    const over = serviceOver(new NamesTheUsers([waiting.userId, passing.userId]));

    let run: Promise<{ result: ClassificationReport; errors: unknown[][] }> | undefined;
    let blocked = false;
    let ended = false;
    try {
      await Promise.race([held.passed, holder]);
      run = capturingErrors(over, () => over.classify({ apply: true }));
      blocked = await waitUntilBlocked({ pid: () => applyPid, settled: run }, holderPid!);
      // Four times the bound, so a loaded box still ends inside it, and under the 30s
      // statement timeout the run would otherwise wait out.
      ended = await settlesWithin(run, 20_000);
    } finally {
      release.open();
    }
    await holder;
    const { result: report, errors } = await run!;

    expect({ blocked, ended, users: report.users, failed: report.failedUsers }).toEqual({
      blocked: true,
      ended: true,
      users: 2,
      failed: [{ userId: waiting.userId, error: 'canceling statement due to lock timeout' }],
    });
    const [context] = errors[0] ?? [];
    const { err } = context as { err: { code?: string; cause?: { code?: string } } };
    expect(err.cause?.code ?? err.code).toBe('55P03');
    // The user given up is as the ingest left it, and the next one is classified.
    expect(await committedState(waiting.userId)).toEqual({
      inputs: [{ credentialId: null, status: 'active' }],
      kinds: [null],
    });
    expect(await committedState(passing.userId)).toEqual({
      inputs: [{ credentialId: passing.credentialId, status: 'active' }],
      kinds: ['feed'],
    });

    const again = await over.classify({ apply: true });

    expect({ failed: again.failedUsers, linked: again.inputsLinked }).toEqual({
      failed: [],
      linked: 1,
    });
    expect(await committedState(waiting.userId)).toEqual({
      inputs: [{ credentialId: waiting.credentialId, status: 'active' }],
      kinds: ['feed'],
    });
  }, 30_000);
});

/**
 * `relabelEntries` reads a row's facts without a lock and asks its caller to
 * hold the row. The pass did not write the rows it lists, so it takes them
 * first, and gives the user up 5s behind a writer that keeps one (R101). The
 * rows are committed: a lock needs a second transaction to be seen.
 */
describe('relabelStaleLabels beside a writer that holds a listed row', () => {
  const rows = committedRows();
  const spies: Array<{ mockRestore(): void }> = [];
  afterEach(async () => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    await rows.drop();
  });

  /** A deposit paired with nothing re-labelling it, committed: the label still says `inflow`. */
  const staleDeposit = () =>
    getDb().transaction(async (tx) => {
      const user = await makeUser(tx);
      rows.users.push(user.id);
      const type = await makeInstitutionType(tx, { code: 'crypto_exchange' });
      const institution = await makeInstitution(tx, { typeId: type.id });
      rows.institutions.push(institution.id);
      const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const token = await makeToken(tx);
      rows.tokens.push(token.id);
      const holding = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
      });
      return entry(tx, holding, {
        kind: 'deposit',
        quantity: '5',
        source: 'etherscan',
        transferGroupId: randomUUID(),
        ledgerKind: 'inflow',
        kindOrigin: 'source',
      });
    });

  /** The backend of the pass's own transaction, read at its first evidence read. */
  function watchingThePass(): () => number | undefined {
    let pid: number | undefined;
    const evidence = Container.get(EngineEvidenceRepository);
    const findHoldingEvidence = evidence.findHoldingEvidence.bind(evidence);
    spies.push(
      spyOn(evidence, 'findHoldingEvidence').mockImplementation(async (scope, tx) => {
        if (tx !== undefined) pid ??= await backendPid(tx);
        return findHoldingEvidence(scope, tx);
      })
    );
    return () => pid;
  }

  const committedLabel = async (id: string) => {
    const [row] = await getDb().select().from(ledger).where(eq(ledger.id, id));
    return {
      transferGroupId: row?.transferGroupId,
      ledgerKind: row?.ledgerKind,
      groupId: row?.groupId,
    };
  };

  /**
   * A stale deposit and a current one on one holding, committed: both paired,
   * and only the first still labelled `inflow`.
   */
  const staleAndCurrent = () =>
    getDb().transaction(async (tx) => {
      const user = await makeUser(tx);
      rows.users.push(user.id);
      const type = await makeInstitutionType(tx, { code: 'crypto_exchange' });
      const institution = await makeInstitution(tx, { typeId: type.id });
      rows.institutions.push(institution.id);
      const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const token = await makeToken(tx);
      rows.tokens.push(token.id);
      const holding = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
      });
      const deposit = () =>
        entry(tx, holding, {
          kind: 'deposit',
          quantity: '5',
          source: 'etherscan',
          transferGroupId: randomUUID(),
          ledgerKind: 'inflow',
          kindOrigin: 'source',
        });
      const stale = await deposit();
      const current = await deposit();
      await Container.get(HoldingTransactionRepository).relabelEntries(user.id, [current.id], tx);
      return { stale, current };
    });

  // SC-1539. The pass takes the rows it listed, then lists again and re-labels
  // only those it took: a label that goes stale meanwhile on another row is on
  // a row it does not hold, so it is left for the next run.
  test('leaves a label that went stale on a row it did not take while it waited', async () => {
    const { stale, current } = await staleAndCurrent();
    // The control: only the first is stale before the writer moves the second.
    expect((await staleOf(stale.userId)).map((label) => label.entryId)).toEqual([stale.id]);

    // The writer holds the stale row, and unpairs the current one so its label goes stale.
    const held = latch();
    const release = latch();
    let writerPid: number | undefined;
    const writer = getDb().transaction(async (tx) => {
      writerPid = await backendPid(tx);
      await tx.select({ id: ledger.id }).from(ledger).where(eq(ledger.id, stale.id)).for('update');
      await tx.update(ledger).set({ transferGroupId: null }).where(eq(ledger.id, current.id));
      held.open();
      await release.passed;
    });

    let pass: ReturnType<FoundationClassificationService['relabelStaleLabels']> | undefined;
    let blocked = false;
    try {
      await Promise.race([held.passed, writer]);
      const passPid = watchingThePass();
      pass = service().relabelStaleLabels({ apply: true, userId: stale.userId });
      blocked = await waitUntilBlocked({ pid: passPid, settled: pass }, writerPid!);
    } finally {
      release.open();
    }
    const outcomes = await Promise.allSettled([writer, pass]);
    const report = await pass!;
    const ids = (labels: readonly { entryId: string }[]) => labels.map((label) => label.entryId);

    expect({
      blocked,
      outcomes: outcomes.map(outcomeOf),
      relabelled: report.relabelled,
      held: ids(report.held),
      stale: ids(report.stale),
    }).toEqual({
      blocked: true,
      outcomes: ['fulfilled', 'fulfilled'],
      relabelled: 1,
      held: [stale.id],
      stale: [current.id],
    });
    expect(await committedLabel(stale.id)).toEqual({
      transferGroupId: stale.transferGroupId,
      ledgerKind: 'transfer_in',
      groupId: stale.transferGroupId,
    });
    // Unpaired by the writer and still labelled as the pair it was.
    expect(await committedLabel(current.id)).toEqual({
      transferGroupId: null,
      ledgerKind: 'transfer_in',
      groupId: current.transferGroupId,
    });
  }, 30_000);

  // SC-1539. A pass given up at its lock timeout after it wrote is rolled back.
  // The other test of the timeout blocks before any write, so it reads the same
  // with or without a rollback; here the re-label is written first and a later
  // statement of the same transaction waits on the writer.
  test('rolls back what it wrote when a later statement gives the user up at its lock timeout', async () => {
    const { stale, current } = await staleAndCurrent();
    const asStored = await committedLabel(stale.id);

    const held = latch();
    const release = latch();
    let writerPid: number | undefined;
    const writer = getDb().transaction(async (tx) => {
      writerPid = await backendPid(tx);
      await tx
        .select({ id: ledger.id })
        .from(ledger)
        .where(eq(ledger.id, current.id))
        .for('update');
      held.open();
      await release.passed;
    });

    // The re-label runs as written, and then the pass's transaction reaches for the writer's row.
    const repository = Container.get(HoldingTransactionRepository);
    const relabelEntries = repository.relabelEntries.bind(repository);
    const written: Array<{ relabelled: number; label: unknown }> = [];
    spies.push(
      spyOn(repository, 'relabelEntries').mockImplementation(async (userId, ids, tx) => {
        const relabelled = await relabelEntries(userId, ids, tx);
        const [row] = await tx.select().from(ledger).where(eq(ledger.id, stale.id));
        written.push({ relabelled, label: row?.ledgerKind });
        await tx
          .select({ id: ledger.id })
          .from(ledger)
          .where(eq(ledger.id, current.id))
          .for('update');
        return relabelled;
      })
    );

    const over = service();
    let pass: ReturnType<typeof capturingErrors<StaleRelabelReport>> | undefined;
    let blocked = false;
    let ended = false;
    try {
      await Promise.race([held.passed, writer]);
      const passPid = watchingThePass();
      pass = capturingErrors(over, () =>
        over.relabelStaleLabels({ apply: true, userId: stale.userId })
      );
      blocked = await waitUntilBlocked({ pid: passPid, settled: pass }, writerPid!);
      // Four times the bound, so a loaded box still ends inside it.
      ended = await settlesWithin(pass, 20_000);
    } finally {
      release.open();
    }
    await writer;
    const { result: report } = await pass!;

    expect({ blocked, ended, written, report }).toEqual({
      blocked: true,
      ended: true,
      // The control: the pass did write before it waited.
      written: [{ relabelled: 1, label: 'transfer_in' }],
      report: {
        apply: true,
        users: 1,
        relabelled: 0,
        held: [],
        stale: [],
        failedUsers: [{ userId: stale.userId, error: 'canceling statement due to lock timeout' }],
      },
    });
    expect(asStored.ledgerKind).toBe('inflow');
    expect(await committedLabel(stale.id)).toEqual(asStored);
  }, 30_000);

  test('waits for the writer, then labels the row from the facts the writer committed, and reports what it wrote', async () => {
    const stale = await staleDeposit();
    expect(await staleOf(stale.userId)).toHaveLength(1);

    // The writer unpairs the row and re-labels it, as a reopen does, and holds it.
    const held = latch();
    const release = latch();
    let writerPid: number | undefined;
    const writer = getDb().transaction(async (tx) => {
      writerPid = await backendPid(tx);
      await tx.update(ledger).set({ transferGroupId: null }).where(eq(ledger.id, stale.id));
      await Container.get(HoldingTransactionRepository).relabelEntries(
        stale.userId,
        [stale.id],
        tx
      );
      held.open();
      await release.passed;
    });

    let pass: ReturnType<FoundationClassificationService['relabelStaleLabels']> | undefined;
    let blocked = false;
    try {
      await Promise.race([held.passed, writer]);
      const passPid = watchingThePass();
      pass = service().relabelStaleLabels({ apply: true, userId: stale.userId });
      blocked = await waitUntilBlocked({ pid: passPid, settled: pass }, writerPid!);
    } finally {
      release.open();
    }
    const outcomes = await Promise.allSettled([writer, pass]);

    expect({ blocked, outcomes: outcomes.map(outcomeOf) }).toEqual({
      blocked: true,
      outcomes: ['fulfilled', 'fulfilled'],
    });
    expect(await committedLabel(stale.id)).toEqual({
      transferGroupId: null,
      ledgerKind: 'inflow',
      groupId: null,
    });
    expect(await staleOf(stale.userId)).toEqual([]);
    // The writer settled the row while the pass waited for it, so the pass
    // held nothing stale and wrote nothing, and says so.
    expect(await pass).toEqual({
      apply: true,
      users: 1,
      relabelled: 0,
      held: [],
      stale: [],
      failedUsers: [],
    });
  });

  test('gives the user up at its lock timeout behind a writer that keeps the row, lists it, and a re-run re-labels the row', async () => {
    const stale = await staleDeposit();
    const listed = await staleOf(stale.userId);
    const asStored = await committedLabel(stale.id);

    // A writer that takes the row and settles nothing, so the label is stale for the re-run.
    const held = latch();
    const release = latch();
    let writerPid: number | undefined;
    const writer = getDb().transaction(async (tx) => {
      writerPid = await backendPid(tx);
      await tx.select({ id: ledger.id }).from(ledger).where(eq(ledger.id, stale.id)).for('update');
      held.open();
      await release.passed;
    });

    const over = service();
    let pass: ReturnType<typeof capturingErrors<StaleRelabelReport>> | undefined;
    let blocked = false;
    let ended = false;
    try {
      await Promise.race([held.passed, writer]);
      const passPid = watchingThePass();
      pass = capturingErrors(over, () =>
        over.relabelStaleLabels({ apply: true, userId: stale.userId })
      );
      blocked = await waitUntilBlocked({ pid: passPid, settled: pass }, writerPid!);
      // Four times the bound, so a loaded box still ends inside it, and under the 30s
      // statement timeout the run would otherwise wait out.
      ended = await settlesWithin(pass, 20_000);
    } finally {
      release.open();
    }
    await writer;
    const { result: report, errors } = await pass!;

    expect({ blocked, ended, report }).toEqual({
      blocked: true,
      ended: true,
      report: {
        apply: true,
        users: 1,
        relabelled: 0,
        held: [],
        stale: [],
        failedUsers: [{ userId: stale.userId, error: 'canceling statement due to lock timeout' }],
      },
    });
    const [context] = errors[0] ?? [];
    const { err } = context as { err: { code?: string; cause?: { code?: string } } };
    expect(err.cause?.code ?? err.code).toBe('55P03');
    // The user given up is as it was: paired, and labelled `inflow`.
    expect(asStored).toEqual({
      transferGroupId: stale.transferGroupId,
      ledgerKind: 'inflow',
      groupId: null,
    });
    expect(await committedLabel(stale.id)).toEqual(asStored);

    const again = await over.relabelStaleLabels({ apply: true, userId: stale.userId });

    expect(listed).toHaveLength(1);
    expect(again).toEqual({
      apply: true,
      users: 1,
      relabelled: 1,
      held: listed,
      stale: [],
      failedUsers: [],
    });
    expect(await committedLabel(stale.id)).toEqual({
      transferGroupId: stale.transferGroupId,
      ledgerKind: 'transfer_in',
      groupId: stale.transferGroupId,
    });
  }, 30_000);
});

import { describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { and, count, eq, isNotNull, or, sql } from 'drizzle-orm';
import { Container } from 'typedi';
import type { HoldingEvidence } from '../../../src/engine/types';
import { EngineEvidenceRepository } from '../../../src/repositories/EngineEvidenceRepository';
import { FeedInputRepository } from '../../../src/repositories/FeedInputRepository';
import { FoundationClassificationService } from '../../../src/services/foundation/FoundationClassificationService';
import { classifyHoldingEvidence } from '../../../src/services/foundation/legacy-classification';
import { planFeedInputs } from '../../../src/services/foundation/plan-feed-inputs';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  makeToken,
} from '../../../test/helpers/factories-extra';

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

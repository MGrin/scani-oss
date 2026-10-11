import { describe, expect, spyOn, test } from 'bun:test';
import { type DatabaseTransaction, getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { and, count, eq, inArray, isNotNull } from 'drizzle-orm';
import { Container } from 'typedi';
import { isDemoPersonaPresent } from '../../src/demo/bootstrap';
import { DemoDatasetSeeder } from '../../src/demo/DemoDatasetSeeder';
import { buildDemoDataset } from '../../src/demo/dataset';
import { EngineEvidenceRepository } from '../../src/repositories/EngineEvidenceRepository';
import {
  type ClassificationReport,
  FoundationClassificationService,
} from '../../src/services/foundation/FoundationClassificationService';
import { withTestDb } from '../../test/helpers/db';

/**
 * The seeder against a real database, inside a transaction that is rolled
 * back: its ~21,500 rows never reach what the rest of the suite reads.
 */

const dataset = buildDemoDataset();

/** What the seeder would leave committed: its user, its prices, the catalog rows it may create. */
async function committedDemoRows() {
  const db = getDb();
  const [users] = await db
    .select({ n: count() })
    .from(schema.users)
    .where(eq(schema.users.email, dataset.user.email));
  const [prices] = await db
    .select({ n: count() })
    .from(schema.tokenPrices)
    .where(eq(schema.tokenPrices.source, 'demo-dataset'));
  const [tokens] = await db
    .select({ n: count() })
    .from(schema.tokens)
    .where(
      inArray(
        schema.tokens.symbol,
        dataset.tokens.map((token) => token.symbol)
      )
    );
  const [institutions] = await db
    .select({ n: count() })
    .from(schema.institutions)
    .where(
      inArray(
        schema.institutions.name,
        dataset.institutions.map((institution) => institution.name)
      )
    );
  return { users: users?.n, prices: prices?.n, tokens: tokens?.n, institutions: institutions?.n };
}

async function labelled(tx: DatabaseTransaction) {
  const [observations] = await tx
    .select({ n: count() })
    .from(schema.holdingBalanceObservations)
    .where(
      and(
        eq(schema.holdingBalanceObservations.userId, dataset.user.id),
        isNotNull(schema.holdingBalanceObservations.role)
      )
    );
  const [entries] = await tx
    .select({ n: count() })
    .from(schema.holdingTransactions)
    .where(
      and(
        eq(schema.holdingTransactions.userId, dataset.user.id),
        isNotNull(schema.holdingTransactions.ledgerKind)
      )
    );
  return { observations: observations?.n ?? 0, entries: entries?.n ?? 0 };
}

/** Each of the persona's holdings as stored: its `kind` and `starts_at`, ordered by id. */
function storedKinds(tx: DatabaseTransaction) {
  return tx
    .select({
      id: schema.holdings.id,
      kind: schema.holdings.kind,
      startsAt: schema.holdings.startsAt,
    })
    .from(schema.holdings)
    .where(eq(schema.holdings.userId, dataset.user.id))
    .orderBy(schema.holdings.id);
}

type StoredKinds = Awaited<ReturnType<typeof storedKinds>>;

/**
 * The seed, with the holdings read as the seeder hands over to its
 * classifier. The classifier fills a NULL `kind` or `starts_at` with the very
 * value the plan states, so a read after the seed cannot tell an INSERT that
 * wrote them from one that left them out.
 */
async function writeReadingTheInsert(tx: DatabaseTransaction): Promise<StoredKinds> {
  const classification = Container.get(FoundationClassificationService);
  const classify = classification.classify.bind(classification);
  let inserted: StoredKinds | undefined;
  const handOver = spyOn(classification, 'classify').mockImplementation(async (options, handle) => {
    inserted = await storedKinds(handle ?? tx);
    return classify(options, handle);
  });
  try {
    await Container.get(DemoDatasetSeeder).write(dataset, tx);
  } finally {
    handOver.mockRestore();
  }
  if (inserted === undefined) throw new Error('the seeder never reached its classifier');
  return inserted;
}

interface Seeded {
  committedBefore: Awaited<ReturnType<typeof committedDemoRows>>;
  committedAfter: Awaited<ReturnType<typeof committedDemoRows>>;
  insertedKinds: StoredKinds;
  personaInside: boolean;
  dryRun: ClassificationReport;
  labelled: Awaited<ReturnType<typeof labelled>>;
}

/** One seed for the whole file, read by whichever test runs first. */
let seeded: Promise<Seeded> | undefined;

function seedOnce(): Promise<Seeded> {
  seeded ??= (async () => {
    const committedBefore = await committedDemoRows();
    const inside = await withTestDb(async (tx) => {
      const insertedKinds = await writeReadingTheInsert(tx);
      return {
        insertedKinds,
        personaInside: await isDemoPersonaPresent(tx),
        dryRun: await Container.get(FoundationClassificationService).classify(
          { apply: false, userId: dataset.user.id },
          tx
        ),
        labelled: await labelled(tx),
      };
    });
    if (!inside) throw new Error('the seeding transaction returned nothing');
    return { committedBefore, committedAfter: await committedDemoRows(), ...inside };
  })();
  return seeded;
}

/**
 * `run`, with the classifier's label write refused: the real service then
 * rolls its user back and reports the failure, and the seeder throws. The
 * service's error log is captured rather than printed into a green run.
 */
async function whileLabelsAreRefused<T>(run: () => Promise<T>): Promise<T> {
  const refused = spyOn(
    Container.get(EngineEvidenceRepository),
    'fillMissingLabels'
  ).mockRejectedValue(new Error('labels refused'));
  // `logger` is private so the service owns its component name.
  const { logger } = Container.get(FoundationClassificationService) as unknown as {
    logger: { error: (context: unknown, message: string) => void };
  };
  const logged = spyOn(logger, 'error').mockImplementation(() => {});
  try {
    return await run();
  } finally {
    logged.mockRestore();
    refused.mockRestore();
  }
}

/**
 * The R97 cases ask what a failed classification leaves behind, which does not
 * depend on how long the history is. 60 days instead of the persona's 549: two
 * full seeds in one test read 18.3s of a 30s budget on main (SC-1593). Each
 * case's control still requires labels to exist, so a set too small to test
 * anything fails loudly.
 */
const short = buildDemoDataset({ days: 60 });

const failedSeed = (tx: DatabaseTransaction) =>
  whileLabelsAreRefused(() =>
    Container.get(DemoDatasetSeeder)
      .write(short, tx)
      .then(
        () => null,
        (error: Error) => error.message
      )
  );

describe('DemoDatasetSeeder.write', () => {
  test('stores the kind and starts_at the plan states for each holding, itself, before its classifier could fill either (R84)', async () => {
    const { insertedKinds } = await seedOnce();

    expect(insertedKinds).toHaveLength(15);
    expect(insertedKinds).toEqual(
      dataset.holdings
        .map((holding) => ({ id: holding.id, kind: holding.kind, startsAt: holding.startsAt }))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
    );
  });

  test('leaves the classifier nothing to fill, so the demo reads as production does after O2', async () => {
    const { dryRun, labelled: rows } = await seedOnce();

    expect(dryRun.failedUsers).toEqual([]);
    // The control: the dry run read the demo's holdings, so the zeros are a reading.
    expect(dryRun.holdings).toEqual({ feed: 10, snapshot: 5 });
    expect(dryRun.inputsPlanned).toBe(0);
    expect(dryRun.rowsUpdated).toEqual({ holdings: 0, observations: 0, entries: 0 });
    expect(rows.observations).toBeGreaterThan(0);
    expect(rows.entries).toBeGreaterThan(0);
  });

  test('writes through the transaction it is handed and nothing beside it', async () => {
    const { personaInside, committedBefore, committedAfter } = await seedOnce();

    // The control: inside the transaction the persona was there to lose.
    expect(personaInside).toBe(true);
    expect(committedAfter).toEqual(committedBefore);
  });
});

describe('DemoDatasetSeeder.write categories (SC-1652)', () => {
  test('seeds the starter set in English and categorizes the fiat spending rows', () =>
    withTestDb(async (tx) => {
      await Container.get(DemoDatasetSeeder).write(short, tx);
      const [user] = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, short.user.email));
      const categories = await tx
        .select()
        .from(schema.transactionCategories)
        .where(eq(schema.transactionCategories.userId, user!.id));
      expect(categories.filter((c) => c.parentId === null)).toHaveLength(8);
      expect(categories).toHaveLength(18);
      const named = new Map(categories.map((c) => [c.id, c]));
      const paths = await tx
        .select({
          description: schema.holdingTransactions.description,
          categoryId: schema.holdingTransactions.categoryId,
        })
        .from(schema.holdingTransactions)
        .where(
          and(
            eq(schema.holdingTransactions.userId, user!.id),
            isNotNull(schema.holdingTransactions.categoryId)
          )
        );
      const pathOf = (id: string) => {
        const c = named.get(id)!;
        return c.parentId ? `${named.get(c.parentId)!.name} › ${c.name}` : c.name;
      };
      const byDescription = new Map(paths.map((r) => [r.description, pathOf(r.categoryId!)]));
      expect(byDescription.get('Monthly interest')).toBe('Income › Interest');
      expect(byDescription.get('Groceries, travel, everything uncategorised')).toBe('Shopping');
    }));
});

describe('DemoDatasetSeeder.write, when its classification fails (R97)', () => {
  test('on a database with no demo it leaves none, so the next boot seeds again', async () => {
    await withTestDb(async (tx) => {
      expect(await isDemoPersonaPresent(tx)).toBe(false);

      expect(await failedSeed(tx)).toBe('demo dataset: classification failed — labels refused');

      expect(await isDemoPersonaPresent(tx)).toBe(false);
    });
  });

  test('on a reseed it leaves the demo that was there, labelled as it was', async () => {
    await withTestDb(async (tx) => {
      await Container.get(DemoDatasetSeeder).write(short, tx);
      const before = { kinds: await storedKinds(tx), labelled: await labelled(tx) };
      // The control: there are labels to lose.
      expect(before.labelled.observations).toBeGreaterThan(0);
      expect(before.labelled.entries).toBeGreaterThan(0);

      expect(await failedSeed(tx)).toBe('demo dataset: classification failed — labels refused');

      expect(await isDemoPersonaPresent(tx)).toBe(true);
      expect({ kinds: await storedKinds(tx), labelled: await labelled(tx) }).toEqual(before);
    });
  });
});

// Anchored in the past: the engine writes the balance as of now and never
// counts a row dated after it (A5 D-1), and the default anchor is in the future.
const settled = buildDemoDataset({ days: 60, anchorDate: '2026-09-01' });

describe('DemoDatasetSeeder.write, with the engine writer guard on (A5 D-4)', () => {
  test('funds every holding through the calculator, at the balance the plan states', async () => {
    await withTestDb(async (tx) => {
      await Container.get(DemoDatasetSeeder).write(settled, tx);

      const rows = await tx
        .select({ id: schema.holdings.id, balance: schema.holdings.balance })
        .from(schema.holdings)
        .where(eq(schema.holdings.userId, settled.user.id));
      expect(rows).toHaveLength(settled.holdings.length);
      expect(new Map(rows.map((row) => [row.id, row.balance]))).toEqual(
        new Map(settled.holdings.map((holding) => [holding.id, holding.balance]))
      );
    });
  });
});

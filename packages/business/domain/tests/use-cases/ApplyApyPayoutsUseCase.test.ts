/**
 * `ApplyApyPayoutsUseCase`, pinned before foundation A2 moved it onto
 * `SnapshotWriter` (Task 1) and asserted against those figures after (Task 3).
 * Every expected value is computed by hand from the fixture, so the move is
 * measured against the old code rather than against whatever the moved code
 * happens to print.
 *
 * The fixture is committed, not held inside `withTestDb`: `execute()` takes no
 * transaction, opens its own and takes an advisory lock on another connection,
 * so nothing a rolled-back wrapper holds can see its writes. Tokens and
 * institutions are not reachable from the user cascade, so they are deleted
 * explicitly (SC-230).
 *
 * 5% a year paid daily. Importing `@scani/shared` sets decimal.js to 28
 * significant digits, half-up. Interest compounds on the full-precision running
 * balance, as it always has, and the balance is that running balance round8:
 *   yesterday  1000 x 0.05 / 365 = 0.136986301369863013698630137
 *              running  1000.136986301369863013698630, round8 1000.13698630
 *   today      1000.136986301369863013698630 x 0.05 / 365
 *                                = 0.137005066616626008632013511
 *              running  1000.273991367986489022330644, round8 1000.27399137
 *
 * Every run also writes the `sync-capture` observation the old path wrote, kept
 * until A5 because legacy history anchors on it (ruling R11). It carries one key
 * the old row did not, `legacyAnchor`, which is how classification knows it when
 * the run booked no row to find beside it (ruling R12).
 *
 * Each row is the step between two round8 balances (ruling R6), 0.1369863 and
 * 0.13700507, so the ledger sums to the balance change exactly. Task 1's rows
 * carried the full-precision interest instead, and walking back from
 * 1000.27399137 through them landed 0.000000002013510977669356 above the 1000
 * the holding started at (A1 carry-forward 5).
 */

import { afterEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import { getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { Decimal } from '@scani/shared';
import { asc, eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingApyConfigRepository } from '../../src/repositories/HoldingApyConfigRepository';
import { FoundationClassificationService } from '../../src/services/foundation/FoundationClassificationService';
import { ApplyApyPayoutsUseCase } from '../../src/use-cases/ApplyApyPayoutsUseCase';
import { makeInstitution, makeInstitutionType, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';
import { captureHistory, expectHistoryUnchanged } from '../../test/helpers/history-neutrality';
import { expectLabelsSettled } from '../../test/helpers/labels-settled';

const DAY_MS = 86_400_000;

// Task 1 recorded these on the path before it moved.
//   config created           1000.27399137 - both full-precision rows
//   between the two payouts  1000.27399137 - 0.137005066616626008632013511
const TASK_1_GOLDEN_HISTORY = [
  { instant: 'config created', balance: '1000.000000002013510977669356' },
  { instant: 'between the two payouts', balance: '1000.136986303383373991367986' },
  { instant: 'just after the run', balance: '1000.27399137' },
  { instant: 'now', balance: '1000.27399137' },
] as const;

// The moved writer's. Readings 3-4 are Task 1's exactly. Readings 1-2 lose the
// A1 carry-forward-5 drift, 2.0e-9 and 3.4e-9, a named sub-display change
// (ruling R3). They are walked back from the run's own observation, which is
// written again (ruling R11), through the 8-dp steps:
//   config created           1000.27399137 - 0.13700507 - 0.1369863
//   between the two payouts  1000.27399137 - 0.13700507
// The steps sum to the balance change exactly, so the interval the observation
// closes has no unexplained drift and nothing is spread across it.
const GOLDEN_HISTORY = [
  { instant: 'config created', balance: '1000' },
  { instant: 'between the two payouts', balance: '1000.1369863' },
  { instant: 'just after the run', balance: '1000.27399137' },
  { instant: 'now', balance: '1000.27399137' },
] as const;

const createdUserIds: string[] = [];
const createdTokenIds: string[] = [];
const createdInstitutionIds: string[] = [];
let narrowing: ReturnType<typeof spyOn> | null = null;

afterEach(async () => {
  setSystemTime();
  narrowing?.mockRestore();
  narrowing = null;
  const db = getDb();
  const users = createdUserIds.splice(0);
  const tokens = createdTokenIds.splice(0);
  const institutions = createdInstitutionIds.splice(0);
  // Users first: their holdings are what keep the token restricted.
  if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
  if (tokens.length) await db.delete(schema.tokens).where(inArray(schema.tokens.id, tokens));
  if (institutions.length) {
    await db.delete(schema.institutions).where(inArray(schema.institutions.id, institutions));
  }
});

/** A holding at `balance`, 5% daily, last paid `daysBack` days ago: a run pays `daysBack` dates. */
async function seed(daysBack = 2, balance = '1000') {
  const createdAt = new Date(Date.now() - daysBack * DAY_MS);
  const fixture = await getDb().transaction(async (tx) => {
    const user = await makeUser(tx);
    const bank = await makeInstitutionType(tx, { code: 'bank' });
    const institution = await makeInstitution(tx, { typeId: bank.id });
    const [savings] = await tx
      .select()
      .from(schema.accountTypes)
      .where(eq(schema.accountTypes.code, 'savings'));
    if (!savings) throw new Error('0000_clean_start seeds the savings account type');
    const account = await makeAccount(tx, {
      userId: user.id,
      institutionId: institution.id,
      typeId: savings.id,
    });
    const token = await makeToken(tx);
    const holding = await makeHolding(tx, {
      userId: user.id,
      accountId: account.id,
      tokenId: token.id,
      balance,
      createdAt,
      lastUpdated: createdAt,
    });
    const [config] = await tx
      .insert(schema.holdingApyConfigs)
      .values({
        holdingId: holding.id,
        annualRatePct: '5',
        payoutFrequency: 'daily',
        lastPayoutAt: createdAt,
        createdAt,
      })
      .returning();
    if (!config) throw new Error('holding_apy_configs insert failed');
    createdUserIds.push(user.id);
    createdTokenIds.push(token.id);
    createdInstitutionIds.push(institution.id);
    return { userId: user.id, tokenId: token.id, holdingId: holding.id, config };
  });

  // `findAllActive` reads every user's configs; a run sees this fixture only,
  // so its counts are this fixture's and it never writes another file's rows.
  const repository = Container.get(HoldingApyConfigRepository);
  const findAllActive = repository.findAllActive.bind(repository);
  narrowing = spyOn(repository, 'findAllActive').mockImplementation(async (tx) =>
    (await findAllActive(tx)).filter((entry) => entry.holdingId === fixture.holdingId)
  );
  return fixture;
}

const run = () => Container.get(ApplyApyPayoutsUseCase).execute();

/** The two UTC midnights a run at `at` pays for, with `lastPayoutAt` two days back. */
function payoutDates(at: Date): [Date, Date] {
  const today = new Date(at);
  today.setUTCHours(0, 0, 0, 0);
  return [new Date(today.getTime() - DAY_MS), today];
}

const day = (date: Date) => date.toISOString().slice(0, 10);

const ledgerOf = (holdingId: string) =>
  getDb()
    .select()
    .from(schema.holdingTransactions)
    .where(eq(schema.holdingTransactions.holdingId, holdingId))
    .orderBy(asc(schema.holdingTransactions.occurredAt));

const observationsOf = (holdingId: string) =>
  getDb()
    .select()
    .from(schema.holdingBalanceObservations)
    .where(eq(schema.holdingBalanceObservations.holdingId, holdingId));

async function holdingOf(holdingId: string) {
  const [row] = await getDb()
    .select()
    .from(schema.holdings)
    .where(eq(schema.holdings.id, holdingId));
  if (!row) throw new Error(`holding ${holdingId} is gone`);
  return row;
}

async function configOf(configId: string) {
  const [row] = await getDb()
    .select()
    .from(schema.holdingApyConfigs)
    .where(eq(schema.holdingApyConfigs.id, configId));
  if (!row) throw new Error(`config ${configId} is gone`);
  return row;
}

describe('ApplyApyPayoutsUseCase', () => {
  test('writes one interest row per due date, quantity the 8-dp step, external id apy:<config>:<yyyy-mm-dd>, source apy-payout', async () => {
    const { userId, tokenId, holdingId, config } = await seed();
    const [yesterday, today] = payoutDates(new Date());

    const result = await run();

    expect(result).toEqual({
      holdingsProcessed: 1,
      payoutsApplied: 2,
      totalInterestApplied: '0.273991367986489022330643648',
      errors: [],
      skipped: 0,
      durationMs: expect.any(Number),
    });
    const sourceMetadata = { configId: config.id, annualRatePct: '5', payoutFrequency: 'daily' };
    const rows = await ledgerOf(holdingId);
    expect(
      rows.map((row) => ({
        userId: row.userId,
        tokenId: row.tokenId,
        kind: row.kind,
        quantity: row.quantity,
        occurredAt: row.occurredAt,
        externalId: row.externalId,
        source: row.source,
        sourceMetadata: row.sourceMetadata,
      }))
    ).toEqual([
      {
        userId,
        tokenId,
        kind: 'interest',
        quantity: '0.1369863',
        occurredAt: yesterday,
        externalId: `apy:${config.id}:${day(yesterday)}`,
        source: 'apy-payout',
        sourceMetadata,
      },
      {
        userId,
        tokenId,
        kind: 'interest',
        quantity: '0.13700507',
        occurredAt: today,
        externalId: `apy:${config.id}:${day(today)}`,
        source: 'apy-payout',
        sourceMetadata,
      },
    ]);
  });

  test('sets holdings.balance to round8 of the compounded total', async () => {
    const { holdingId } = await seed();
    const before = Date.now();

    await run();

    const after = Date.now();
    const holding = await holdingOf(holdingId);
    expect(holding.balance).toBe('1000.27399137');
    expect(holding.lastUpdated.getTime()).toBeGreaterThanOrEqual(before);
    expect(holding.lastUpdated.getTime()).toBeLessThanOrEqual(after);
  });

  test('a second run the same day writes no row and leaves the balance', async () => {
    const { holdingId } = await seed();
    await run();
    const ledger = await ledgerOf(holdingId);
    const holding = await holdingOf(holdingId);

    const second = await run();

    expect(second).toEqual({
      holdingsProcessed: 1,
      payoutsApplied: 0,
      totalInterestApplied: '0',
      errors: [],
      skipped: 1,
      durationMs: expect.any(Number),
    });
    expect(await ledgerOf(holdingId)).toEqual(ledger);
    expect(await holdingOf(holdingId)).toEqual(holding);
  });

  test('stamps lastPayoutAt', async () => {
    const { config } = await seed();
    const before = Date.now();

    await run();

    const after = Date.now();
    const { lastPayoutAt } = await configOf(config.id);
    expect(lastPayoutAt?.getTime()).toBeGreaterThanOrEqual(before);
    expect(lastPayoutAt?.getTime()).toBeLessThanOrEqual(after);
  });

  test('writes one observation: source sync-capture, origin updateHoldingBalance, marked as the APY anchor (ruling R12)', async () => {
    const { userId, holdingId } = await seed();

    await run();

    const observations = await observationsOf(holdingId);
    expect(
      observations.map((o) => ({
        userId: o.userId,
        balance: o.balance,
        source: o.source,
        sourceMetadata: o.sourceMetadata,
      }))
    ).toEqual([
      {
        userId,
        balance: '1000.27399137',
        source: 'sync-capture',
        sourceMetadata: { origin: 'updateHoldingBalance', legacyAnchor: 'apy-payout' },
      },
    ]);
  });

  test('the observation is unlabelled, stamped inside the run and written with the rows (ruling R11)', async () => {
    const { holdingId } = await seed();
    const before = Date.now();

    await run();

    const after = Date.now();
    const [observation] = await observationsOf(holdingId);
    if (!observation) throw new Error('the run wrote no observation');
    expect({
      role: observation.role,
      authority: observation.authority,
      inputId: observation.inputId,
      cause: observation.cause,
      supersededAt: observation.supersededAt,
    }).toEqual({ role: null, authority: null, inputId: null, cause: null, supersededAt: null });
    expect(observation.observedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(observation.observedAt.getTime()).toBeLessThanOrEqual(after);
    // One transaction: A1 tells this copy from a typed value by the instant it
    // shares with the payout rows (rule O3).
    const written = (await ledgerOf(holdingId)).map((row) => row.createdAt.getTime());
    expect(written).toEqual([observation.createdAt.getTime(), observation.createdAt.getTime()]);
  });

  test('a second run the same day writes no second observation', async () => {
    const { holdingId } = await seed();

    await run();
    await run();

    expect(await observationsOf(holdingId)).toHaveLength(1);
  });

  test('a later reading the ledger does not explain lands after the last payout run: every day up to it reads what had accrued (ruling R11)', async () => {
    // Two runs, two dates each. The second starts from the stored 1000.27399137:
    //   run 1  1000.1369863, 1000.27399137   rows 0.1369863, 0.13700507
    //   run 2  1000.4110152, 1000.54805781   rows 0.13702383, 0.13704261
    const { userId, holdingId, config } = await seed(4);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const midday = (daysBack: number) => new Date(today.getTime() - daysBack * DAY_MS + DAY_MS / 2);
    const o = schema.holdingBalanceObservations;
    // What creating the holding wrote, four days back.
    await getDb()
      .insert(o)
      .values({
        userId,
        holdingId,
        balance: '1000',
        observedAt: config.createdAt,
        source: 'sync-capture',
        sourceMetadata: { origin: 'createHoldingWithEvent', source: 'manual' },
      });

    setSystemTime(new Date(Date.now() - 2 * DAY_MS));
    await run();
    setSystemTime();
    await run();
    // Ten days on the person trues the balance up: 99.45194219 no row explains.
    const trueUpAt = new Date(Date.now() + 10 * DAY_MS);
    await getDb()
      .insert(o)
      .values({
        userId,
        holdingId,
        balance: '1100',
        observedAt: trueUpAt,
        source: 'sync-capture',
        sourceMetadata: { origin: 'updateHolding' },
      });

    // Each run's observation closes an interval its rows explain to the cent, so
    // the 99.45194219 is spread only after the second run. Without those two
    // observations it is drawn as one line from the day the holding was
    // created, and every reading below sits on that line.
    const readings = await captureHistory(
      [holdingId],
      [config.createdAt, midday(3), midday(1), trueUpAt]
    );
    expect(readings.map((reading) => reading.balance)).toEqual([
      '1000',
      '1000.1369863',
      '1000.4110152',
      '1100',
    ]);
    expect((await observationsOf(holdingId)).map((row) => row.balance).sort()).toEqual([
      '1000',
      '1000.27399137',
      '1000.54805781',
      '1100',
    ]);
  });

  test('each entry is the step of an 8-dp running balance: b_0 = the stored balance, b_k = round8(full_k) where interest compounds on the full-precision balance, entry_k = b_k − b_(k-1) (ruling R6)', async () => {
    // Four payouts, because two cannot tell this rule from compounding on the
    // rounded balance: b_k = round8(b_(k-1) + interest on b_(k-1)) gives the same
    // first three steps, then 0.13704260 and a balance of 1000.54805780, one in
    // the 8th decimal below the figure the use case has always written.
    //   k  full_k                          b_k            entry_k
    //   1  1000.136986301369863013698630   1000.13698630  0.1369863
    //   2  1000.273991367986489022330644   1000.27399137  0.13700507
    //   3  1000.411015202420459774251511   1000.41101520  0.13702383
    //   4  1000.548057807242709152302778   1000.54805781  0.13704261
    const { holdingId } = await seed(4);

    await run();

    const quantities = (await ledgerOf(holdingId)).map((row) => row.quantity);
    expect(quantities).toEqual(['0.1369863', '0.13700507', '0.13702383', '0.13704261']);
    const { balance } = await holdingOf(holdingId);
    expect(balance).toBe('1000.54805781');
    const sum = quantities.reduce((total, q) => total.plus(q), new Decimal(0));
    expect(sum.toFixed()).toBe(new Decimal(balance).minus('1000').toFixed());
  });

  // Ruling R10: a row is never zero or negative. A step that is not positive is
  // carried into the next date, and a date writes a row only once the amount
  // carried to it is above zero, booking all of it.
  test("a tiny balance whose daily step rounds to 0 writes no zero row and leaves the balance at today's value", async () => {
    //   k  full_k                                b_k       step
    //   1  0.000001000136986301369863013698630   0.000001  0
    //   2  0.000001000273991367986489022330644   0.000001  0
    const { holdingId, config } = await seed(2, '0.000001');
    const before = Date.now();

    const result = await run();

    const after = Date.now();
    expect(await ledgerOf(holdingId)).toEqual([]);
    // The run still happened: the balance is written, as it always was, and the config stamped.
    const holding = await holdingOf(holdingId);
    expect(holding.balance).toBe('0.000001');
    expect(holding.lastUpdated.getTime()).toBeGreaterThanOrEqual(before);
    expect(holding.lastUpdated.getTime()).toBeLessThanOrEqual(after);
    expect((await configOf(config.id)).lastPayoutAt?.getTime()).toBeGreaterThanOrEqual(before);
    expect({ payoutsApplied: result.payoutsApplied, errors: result.errors }).toEqual({
      payoutsApplied: 2,
      errors: [],
    });
  });

  test('a stored balance with more than 8 dp whose first step is negative writes no negative row, and the rows sum to the positive part booked', async () => {
    // The stored figure sits 1e-9 above the 8-dp grid, and a day's interest is
    // 1.37e-9, so the first rounding lands below where the holding started.
    //   k  full_k                               b_k         step         carried  row
    //   1  0.00001000237                        0.00001     -0.000000001  -1e-9    none
    //   2  0.00001000374018767123287671232877   0.00001     0             -1e-9    none
    //   3  0.00001000511056303940701820228936   0.00001001  0.00000001    9e-9     0.000000009
    //   4  0.00001000648112613023433423218008   0.00001001  0             0        none
    const { holdingId, config } = await seed(4, '0.000010001');
    const [yesterday] = payoutDates(new Date());

    await run();

    const rows = await ledgerOf(holdingId);
    expect(
      rows.map((row) => ({
        quantity: row.quantity,
        occurredAt: row.occurredAt,
        externalId: row.externalId,
      }))
    ).toEqual([
      {
        quantity: '0.000000009',
        occurredAt: yesterday,
        externalId: `apy:${config.id}:${day(yesterday)}`,
      },
    ]);
    const { balance } = await holdingOf(holdingId);
    expect(balance).toBe('0.00001001');
    // Here the whole change is booked: the written rows sum to 0.00001001 - 0.000010001.
    const booked = rows.reduce((total, row) => total.plus(row.quantity), new Decimal(0));
    expect(booked.toFixed()).toBe(new Decimal(balance).minus('0.000010001').toFixed());
  });

  test('a run that nets below zero writes no row', async () => {
    // The first two dates of the fixture above: the carry is still -1e-9 when
    // the run ends, so nothing is booked. The balance is the round8 figure the
    // use case has always written.
    const { holdingId } = await seed(2, '0.000010001');

    await run();

    expect(await ledgerOf(holdingId)).toEqual([]);
    expect((await holdingOf(holdingId)).balance).toBe('0.00001');
  });

  // Ruling R10a: the carry is relative to the direction interest accrues in,
  // not to zero. A balance below zero accrues downwards, and those rows are
  // real money: without them every past date reads today's figure.
  test('a balance below zero books its negative interest: the 8-dp steps the path has always written, summing to the balance change', async () => {
    //   k  interest_k                       full_k                           b_k              row
    //   1  -1.369863013698630136986301370   -10001.36986301369863013698630   -10001.36986301  -1.36986301
    //   2  -1.370050666166260086320135110   -10002.73991367986489022330644   -10002.73991368  -1.37005067
    const { holdingId, config } = await seed(2, '-10000');
    const [yesterday, today] = payoutDates(new Date());

    await run();

    const rows = await ledgerOf(holdingId);
    expect(
      rows.map((row) => ({
        kind: row.kind,
        quantity: row.quantity,
        occurredAt: row.occurredAt,
        externalId: row.externalId,
      }))
    ).toEqual([
      {
        kind: 'interest',
        quantity: '-1.36986301',
        occurredAt: yesterday,
        externalId: `apy:${config.id}:${day(yesterday)}`,
      },
      {
        kind: 'interest',
        quantity: '-1.37005067',
        occurredAt: today,
        externalId: `apy:${config.id}:${day(today)}`,
      },
    ]);
    const { balance } = await holdingOf(holdingId);
    expect(balance).toBe('-10002.73991368');
    const booked = rows.reduce((total, row) => total.plus(row.quantity), new Decimal(0));
    expect(booked.toFixed()).toBe('-2.73991368');
    expect(booked.toFixed()).toBe(new Decimal(balance).minus('-10000').toFixed());
  });

  test('below zero the rounding artefact is the positive step: it is carried, and no zero or positive row is written', async () => {
    // The mirror of the off-grid fixture above. Keeping every signed step
    // below zero would write +0.000000001, 0, -0.00000001 and 0 here.
    //   k  full_k                                b_k          step          carried  row
    //   1  -0.00001000237                        -0.00001     0.000000001   1e-9     none
    //   2  -0.00001000374018767123287671232877   -0.00001     0             1e-9     none
    //   3  -0.00001000511056303940701820228936   -0.00001001  -0.00000001   -9e-9    -0.000000009
    //   4  -0.00001000648112613023433423218008   -0.00001001  0             0        none
    const { holdingId } = await seed(4, '-0.000010001');
    const [yesterday] = payoutDates(new Date());

    await run();

    const rows = await ledgerOf(holdingId);
    expect(rows.map((row) => ({ quantity: row.quantity, occurredAt: row.occurredAt }))).toEqual([
      { quantity: '-0.000000009', occurredAt: yesterday },
    ]);
    expect((await holdingOf(holdingId)).balance).toBe('-0.00001001');
  });

  test('records golden history', async () => {
    const { holdingId, config } = await seed();
    const [yesterday] = payoutDates(new Date());

    await run();
    const justAfter = new Date();

    const golden = await captureHistory(
      [holdingId],
      [config.createdAt, new Date(yesterday.getTime() + DAY_MS / 2), justAfter, new Date()]
    );
    expect(
      golden.map((reading, i) => ({
        instant: GOLDEN_HISTORY[i]?.instant,
        balance: reading.balance,
      }))
    ).toEqual([...GOLDEN_HISTORY]);

    await run();
    await expectHistoryUnchanged(golden);
    // The controls: a moved figure must fail, and a moved anchor alone must not.
    const moved = golden.map((reading, i) => (i === 1 ? { ...reading, balance: '1000' } : reading));
    await expect(expectHistoryUnchanged(moved)).rejects.toThrow();
    await expectHistoryUnchanged(golden.map((reading) => ({ ...reading, anchor: null })));
  });

  test("history is unchanged against Task 1's golden snapshot after the run", async () => {
    const { holdingId } = await seed();

    await run();
    const justAfter = new Date();

    const readings = await captureHistory([holdingId], [justAfter, new Date()]);
    expect(readings.map((reading) => reading.balance)).toEqual([
      TASK_1_GOLDEN_HISTORY[2].balance,
      TASK_1_GOLDEN_HISTORY[3].balance,
    ]);
  });

  test('history before the run moves only by the A1 carry-forward-5 drift', async () => {
    const { holdingId, config } = await seed();
    const [yesterday] = payoutDates(new Date());

    await run();

    const readings = await captureHistory(
      [holdingId],
      [config.createdAt, new Date(yesterday.getTime() + DAY_MS / 2)]
    );
    const figures = readings.map((reading) => reading.balance);
    expect(figures).toEqual([GOLDEN_HISTORY[0].balance, GOLDEN_HISTORY[1].balance]);
    // Below the 8th decimal, so no display precision shows it.
    const drift = figures.map((figure, i) =>
      new Decimal(TASK_1_GOLDEN_HISTORY[i]!.balance).minus(figure ?? 'NaN').toFixed()
    );
    expect(drift).toEqual(['0.000000002013510977669356', '0.000000003383373991367986']);
  });

  test('the kept observation is classified fabricated (O3) and excluded, and labels stay settled (ruling R11)', async () => {
    const { userId } = await seed();
    const classification = Container.get(FoundationClassificationService);
    await classification.classify({ apply: true, userId });

    await run();

    const report = await classification.classify({ apply: false, userId });
    expect({
      rule: report.notes['obs:O3'],
      excluded: report.excluded['fabricated-observation'],
      toLabel: report.rowsUpdated.observations,
      failedUsers: report.failedUsers,
    }).toEqual({ rule: 1, excluded: 1, toLabel: 0, failedUsers: [] });
    await expectLabelsSettled(userId);
  });

  test('a run that books no row still writes the observation (ruling R11)', async () => {
    const { holdingId } = await seed(2, '0.000001');

    await run();

    expect(await ledgerOf(holdingId)).toEqual([]);
    expect((await observationsOf(holdingId)).map((row) => row.balance)).toEqual(['0.000001']);
  });

  test('a run that books no row leaves an observation classification excludes: nothing to label, and a second backfill labels nothing and keeps the kind (ruling R12)', async () => {
    const { userId, holdingId } = await seed(2, '0.000001');
    const classification = Container.get(FoundationClassificationService);
    await classification.classify({ apply: true, userId });
    const { kind } = await holdingOf(holdingId);

    await run();

    expect(await ledgerOf(holdingId)).toEqual([]);
    const report = await classification.classify({ apply: false, userId });
    expect({
      fabricated: report.notes['obs:O3'] ?? 0,
      personValue: report.notes['obs:O5'] ?? 0,
      excluded: report.excluded['fabricated-observation'] ?? 0,
      toLabel: report.rowsUpdated.observations,
      failedUsers: report.failedUsers,
    }).toEqual({ fabricated: 1, personValue: 0, excluded: 1, toLabel: 0, failedUsers: [] });
    await expectLabelsSettled(userId);

    await classification.classify({ apply: true, userId });
    const [observation] = await observationsOf(holdingId);
    expect({
      role: observation?.role,
      authority: observation?.authority,
      cause: observation?.cause,
    }).toEqual({ role: null, authority: null, cause: null });
    expect(kind).toBe('snapshot');
    expect((await holdingOf(holdingId)).kind).toBe(kind);
  });

  test('an observation written before the marker existed is still fabricated (O3) by the payout row beside it (ruling R12)', async () => {
    const { userId, holdingId } = await seed();
    const classification = Container.get(FoundationClassificationService);
    await classification.classify({ apply: true, userId });
    await run();
    // As main wrote it: the origin and nothing else.
    await getDb()
      .update(schema.holdingBalanceObservations)
      .set({ sourceMetadata: { origin: 'updateHoldingBalance' } })
      .where(eq(schema.holdingBalanceObservations.holdingId, holdingId));

    const report = await classification.classify({ apply: false, userId });
    expect({
      fabricated: report.notes['obs:O3'] ?? 0,
      excluded: report.excluded['fabricated-observation'] ?? 0,
      toLabel: report.rowsUpdated.observations,
      failedUsers: report.failedUsers,
    }).toEqual({ fabricated: 1, excluded: 1, toLabel: 0, failedUsers: [] });
    await expectLabelsSettled(userId);
  });

  test('labels are settled after the run on a backfilled fixture', async () => {
    const { userId } = await seed();
    await Container.get(FoundationClassificationService).classify({ apply: true, userId });

    await run();

    await expectLabelsSettled(userId);
  });
});

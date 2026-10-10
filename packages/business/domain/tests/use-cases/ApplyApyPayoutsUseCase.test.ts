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
 * A run writes no observation. Until A5 it also wrote the `sync-capture` copy of
 * the new balance the old path wrote (rulings R11, R12): a reading nobody took,
 * which legacy history anchored on. Ops O1 deletes the ones already written.
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
// (ruling R3). Since A5 PR-2 the engine walks them FORWARD from the creation
// reading through the 8-dp steps, and lands on the same figures:
//   config created           1000
//   between the two payouts  1000 + 0.1369863
// The steps sum to the balance change exactly, so nothing is left over.
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
  await recordCreationReading(fixture.userId, fixture.holdingId, createdAt, balance);

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

/**
 * The reading every create path has written since A2, which `seed` records for
 * each fixture: since A5 the engine writes the stored balance from evidence,
 * so a holding funded with no reading would read as its payouts alone.
 */
const recordCreationReading = (userId: string, holdingId: string, at: Date, balance = '1000') =>
  getDb()
    .insert(schema.holdingBalanceObservations)
    .values({
      userId,
      holdingId,
      balance,
      observedAt: at,
      source: 'sync-capture',
      sourceMetadata: { origin: 'createHoldingWithEvent', source: 'manual' },
    });

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

  test('the balance is the engine sum of the reading and the booked row, below 8 dp too', async () => {
    // One yearly payout at 300% on a 28-digit reading. The run books the round8
    // total less the reading, and since A5 the cache is the engine's figure:
    // the reading plus that row, summed at Decimal's 28 digits, which keeps a
    // 1e-17 tail the round8 total does not have. History reads the same.
    const { holdingId, config } = await seed(2, '5000000000.000000000000000005');
    const today = new Date();
    await getDb()
      .update(schema.holdingApyConfigs)
      .set({
        annualRatePct: '300',
        payoutFrequency: 'yearly',
        payoutMonth: today.getUTCMonth() + 1,
        payoutDayOfMonth: today.getUTCDate(),
      })
      .where(eq(schema.holdingApyConfigs.id, config.id));

    await run();

    expect((await holdingOf(holdingId)).balance).toBe('20000000000.00000000000000001');
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

  test('writes no observation: the balance moves and nothing claims it was read (A5)', async () => {
    const { holdingId } = await seed();

    const readings = await observationsOf(holdingId);

    await run();
    await run();

    expect(await observationsOf(holdingId)).toEqual(readings);
    expect((await holdingOf(holdingId)).balance).toBe('1000.27399137');
  });

  test('a later reading the ledger does not explain lands on its own day; the days before read the payouts (A5 PR-2)', async () => {
    // Two runs, two dates each. The second starts from the stored 1000.27399137:
    //   run 1  1000.1369863, 1000.27399137   rows 0.1369863, 0.13700507
    //   run 2  1000.4110152, 1000.54805781   rows 0.13702383, 0.13704261
    const { userId, holdingId, config } = await seed(4);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const midday = (daysBack: number) => new Date(today.getTime() - daysBack * DAY_MS + DAY_MS / 2);

    setSystemTime(new Date(Date.now() - 2 * DAY_MS));
    await run();
    setSystemTime();
    await run();
    // Ten days on the person trues the balance up: 99.45194219 no row explains.
    const trueUpAt = new Date(Date.now() + 10 * DAY_MS);
    await getDb()
      .insert(schema.holdingBalanceObservations)
      .values({
        userId,
        holdingId,
        balance: '1100',
        observedAt: trueUpAt,
        source: 'sync-capture',
        sourceMetadata: { origin: 'updateHolding' },
      });

    const payouts = await ledgerOf(holdingId);
    const paid = payouts.reduce((sum, row) => sum.add(row.quantity), new Decimal(0));
    expect(new Decimal('1100').minus('1000').minus(paid).toString()).toBe('99.45194219');
    // The old walk spread that 99.45194219 along a straight line back to the
    // creation reading. The engine walks forward from the latest reading, so
    // every day before the true-up reads exactly what was paid, and the gap is
    // a step on the true-up's own day (A5 D-10, SC-475 fault B).
    const forward = (at: Date) =>
      payouts
        .filter((row) => row.occurredAt.getTime() <= at.getTime())
        .reduce((sum, row) => sum.add(row.quantity), new Decimal('1000'));
    const before = [config.createdAt, midday(3), midday(1)];
    const readings = await captureHistory([holdingId], [...before, trueUpAt]);
    expect(readings.map((reading) => reading.balance)).toEqual([
      ...before.map((at) => forward(at).toFixed()),
      '1100',
    ]);
    // The control: a figure the old spread would have read is not what we read.
    expect(readings[1]?.balance).toBe('1000.1369863');
    expect((await observationsOf(holdingId)).map((row) => row.balance).sort()).toEqual([
      '1000',
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
    // the run ends, so nothing is booked, and the balance stays the reading.
    // The round8 figure the use case wrote before A5 was a write no row explained.
    const { holdingId } = await seed(2, '0.000010001');

    await run();

    expect(await ledgerOf(holdingId)).toEqual([]);
    expect((await holdingOf(holdingId)).balance).toBe('0.000010001');
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

  // Classification still recognises a copy an earlier run wrote, by its marker
  // or by the payout row beside it, until O1 deletes the last one; its own
  // tests cover both arms (legacy-classification.test.ts, rule O3).
  test('a run leaves classification no copy to exclude, and labels stay settled (A5)', async () => {
    const { userId, holdingId } = await seed();
    const classification = Container.get(FoundationClassificationService);
    await classification.classify({ apply: true, userId });
    const { kind } = await holdingOf(holdingId);

    await run();

    const report = await classification.classify({ apply: false, userId });
    expect({
      fabricated: report.notes['obs:O3'] ?? 0,
      excluded: report.excluded['fabricated-observation'] ?? 0,
      toLabel: report.rowsUpdated.observations,
      failedUsers: report.failedUsers,
    }).toEqual({ fabricated: 0, excluded: 0, toLabel: 0, failedUsers: [] });
    await expectLabelsSettled(userId);
    expect((await holdingOf(holdingId)).kind).toBe(kind);
  });

  test('a run that books no row writes nothing (A5)', async () => {
    const { holdingId } = await seed(2, '0.000001');
    const readings = await observationsOf(holdingId);

    await run();

    expect(await ledgerOf(holdingId)).toEqual([]);
    expect(await observationsOf(holdingId)).toEqual(readings);
  });

  test('labels are settled after the run on a backfilled fixture', async () => {
    const { userId } = await seed();
    await Container.get(FoundationClassificationService).classify({ apply: true, userId });

    await run();

    await expectLabelsSettled(userId);
  });
});

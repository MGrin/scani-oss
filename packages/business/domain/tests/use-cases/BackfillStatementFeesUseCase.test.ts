import { afterEach, describe, expect, test } from 'bun:test';
import { getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { and, eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { OpeningBalanceReconciliationService } from '../../src/services/holdings/OpeningBalanceReconciliationService';
import { BackfillStatementFeesUseCase } from '../../src/use-cases/BackfillStatementFeesUseCase';
import { makeInstitution, makeInstitutionType, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

/**
 * These run against a **committed** fixture rather than inside `withTestDb`.
 *
 * The whole claim under test is that running the backfill twice changes
 * nothing the second time, and both the candidate query and
 * `OpeningBalanceReconciliationService` read the database through their own
 * connections — a rolled-back transaction would hide exactly the behaviour
 * that matters. Every run is scoped to its own `userId` so it cannot see, or
 * be seen by, a suite running beside it, and the fixture user is deleted
 * afterwards.
 *
 * Deleting the user does NOT take the rest, which is what made this file the
 * one that leaked (SC-230). `tokens` carries no `user_id` — it is shared
 * reference data, not user data — so the FK cascade never reaches it and six
 * rows survived every full-suite run. They accumulated in the shared local
 * database until the `tokens` unique constraint started rejecting other
 * suites' fixtures, and the file that failed was never this one.
 *
 * So the token ids are tracked and deleted explicitly. Anything committed
 * here that is not reachable from `users` by a cascade has to be.
 */

const useCase = () => Container.get(BackfillStatementFeesUseCase);

const createdUserIds: string[] = [];
const createdTokenIds: string[] = [];
const createdInstitutionIds: string[] = [];

afterEach(async () => {
  const db = getDb();
  while (createdUserIds.length > 0) {
    const userId = createdUserIds.pop() as string;
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  }
  // After the users, because holdings and holding_transactions reference the
  // token and only disappear with the user that owns them.
  while (createdTokenIds.length > 0) {
    const tokenId = createdTokenIds.pop() as string;
    await db.delete(schema.tokens).where(eq(schema.tokens.id, tokenId));
  }
  // Institutions are shared reference data too, for the same reason and with
  // the same consequence — they were accumulating six a run beside the tokens.
  while (createdInstitutionIds.length > 0) {
    const institutionId = createdInstitutionIds.pop() as string;
    await db.delete(schema.institutions).where(eq(schema.institutions.id, institutionId));
  }
});

interface Fixture {
  userId: string;
  holdingId: string;
  tokenId: string;
}

/**
 * A holding whose statement rows look exactly like a pre-#744 Revolut import:
 * the movement is on the ledger, the fee is only in `raw_payload`, and the
 * `holdings.balance` anchor already reflects both.
 */
async function seedPreFixImport(rows: { amount: string; fee: string | null }[]): Promise<Fixture> {
  const db = getDb();
  return await db.transaction(async (tx) => {
    const user = await makeUser(tx);
    const institutionType = await makeInstitutionType(tx);
    const institution = await makeInstitution(tx, { typeId: institutionType.id });
    const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
    const token = await makeToken(tx);
    // The anchored closing balance: the sum of the amounts AND the fees, which
    // is what the bank's own Balance column says. The ledger below is short by
    // the fees, which is the defect.
    const closing = rows.reduce(
      (total, row) => total + Number(row.amount) - Number(row.fee ?? 0),
      1000
    );
    const holding = await makeHolding(tx, {
      userId: user.id,
      accountId: account.id,
      tokenId: token.id,
      balance: String(closing),
    });

    await tx.insert(schema.holdingTransactions).values(
      rows.map((row, index) => ({
        userId: user.id,
        holdingId: holding.id,
        tokenId: token.id,
        kind: Number(row.amount) >= 0 ? 'deposit' : 'withdraw',
        quantity: row.amount,
        occurredAt: new Date(`2024-0${index + 1}-15T10:00:00Z`),
        externalId: `revolut-row-${index}`,
        source: 'statement-csv',
        sourceMetadata: {
          description: `Row ${index}`,
          bankTemplate: 'revolut',
          format: 'csv',
        },
        rawPayload: {
          'Started Date': `2024-0${index + 1}-15 10:00:00`,
          Description: `Row ${index}`,
          Amount: row.amount,
          Currency: 'EUR',
          Fee: row.fee ?? '0.00',
        },
      }))
    );

    createdUserIds.push(user.id);
    createdTokenIds.push(token.id);
    createdInstitutionIds.push(institution.id);
    return { userId: user.id, holdingId: holding.id, tokenId: token.id };
  });
}

async function feeRows(holdingId: string) {
  return await getDb()
    .select()
    .from(schema.holdingTransactions)
    .where(
      and(
        eq(schema.holdingTransactions.holdingId, holdingId),
        eq(schema.holdingTransactions.kind, 'fee')
      )
    );
}

describe('BackfillStatementFeesUseCase', () => {
  test('writes the fee row the ingester would have written, from raw_payload alone', async () => {
    const fixture = await seedPreFixImport([
      { amount: '-120.00', fee: '1.50' },
      { amount: '250.00', fee: null },
    ]);

    const summary = await useCase().execute({ userId: fixture.userId });

    expect(summary.scanned).toBe(2);
    expect(summary.feesFound).toBe(1);
    expect(summary.feesWritten).toBe(1);
    expect(summary.totalFeeMagnitude).toBe('1.5');
    expect(summary.holdingsTouched).toBe(1);

    const fees = await feeRows(fixture.holdingId);
    expect(fees).toHaveLength(1);
    const fee = fees[0];
    // Negative: the ledger sums `quantity`, and a fee is an outflow.
    expect(fee?.quantity).toBe('-1.5');
    expect(fee?.externalId).toBe('revolut-row-0:fee');
    expect(fee?.source).toBe('statement-csv');
    expect(fee?.occurredAt.toISOString()).toBe('2024-01-15T10:00:00.000Z');
    expect(fee?.tokenId).toBe(fixture.tokenId);
    const metadata = fee?.sourceMetadata as Record<string, unknown>;
    expect(metadata.feeForExternalId).toBe('revolut-row-0');
    expect(metadata.description).toBe('Fee — Row 0');
    expect(metadata.bankTemplate).toBe('revolut');
  });

  test('running it twice does not double anything', async () => {
    const fixture = await seedPreFixImport([
      { amount: '-120.00', fee: '1.50' },
      { amount: '-80.00', fee: '2.25' },
    ]);

    const first = await useCase().execute({ userId: fixture.userId });
    const afterFirst = await feeRows(fixture.holdingId);
    const openingAfterFirst = await openingBalance(fixture.holdingId);

    const second = await useCase().execute({ userId: fixture.userId });
    const afterSecond = await feeRows(fixture.holdingId);
    const openingAfterSecond = await openingBalance(fixture.holdingId);

    expect(first.feesWritten).toBe(2);
    expect(first.totalFeeMagnitude).toBe('3.75');

    // The second pass finds no candidates at all: every parent now has a
    // `:fee` sibling, which is the ingester's own idempotency key.
    expect(second.scanned).toBe(0);
    expect(second.feesFound).toBe(0);
    expect(second.feesWritten).toBe(0);
    expect(second.holdingsTouched).toBe(0);

    expect(afterSecond).toHaveLength(afterFirst.length);
    expect(afterSecond).toHaveLength(2);
    expect(sumQuantities(afterSecond)).toBe(sumQuantities(afterFirst));
    expect(sumQuantities(afterSecond)).toBe(-3.75);
    // And the derived opening did not move either — the reconciler replaces
    // its own prior output rather than compounding it.
    expect(openingAfterSecond).toBe(openingAfterFirst);
  });

  test('the fees raise the derived opening balance by exactly their sum', async () => {
    const withoutBackfill = await seedPreFixImport([{ amount: '-120.00', fee: '1.50' }]);
    await Container.get(OpeningBalanceReconciliationService).reconcileHolding(
      withoutBackfill.holdingId
    );
    const before = await openingBalance(withoutBackfill.holdingId);

    await useCase().execute({ userId: withoutBackfill.userId });
    const after = await openingBalance(withoutBackfill.holdingId);

    // holdings.balance = 1000 - 120 - 1.50 = 878.50, ledger sums to -120,
    // so the opening was 998.50 and is 1000 once the fee is on the ledger.
    expect(before).toBe(998.5);
    expect(after).toBe(1000);
  });

  test('dry run reports the same fees and writes nothing', async () => {
    const fixture = await seedPreFixImport([{ amount: '-120.00', fee: '1.50' }]);

    const dry = await useCase().execute({ userId: fixture.userId, dryRun: true });

    expect(dry.feesFound).toBe(1);
    expect(dry.feesWritten).toBe(0);
    expect(dry.totalFeeMagnitude).toBe('1.5');
    expect(await feeRows(fixture.holdingId)).toHaveLength(0);
  });

  test('a zero fee column is not a fee — every Revolut row carries 0.00', async () => {
    const fixture = await seedPreFixImport([
      { amount: '-120.00', fee: '0.00' },
      { amount: '-80.00', fee: null },
    ]);

    const summary = await useCase().execute({ userId: fixture.userId });

    expect(summary.scanned).toBe(2);
    expect(summary.feesFound).toBe(0);
    expect(await feeRows(fixture.holdingId)).toHaveLength(0);
  });

  test('a row whose bank template names no fee column is skipped', async () => {
    const fixture = await seedPreFixImport([{ amount: '-120.00', fee: '1.50' }]);
    // Monzo's template has no `fee` mapping, so a `Fee` key on the payload is
    // not a fee this import ever read — resolution follows the row's own
    // template, exactly as the parse did.
    await getDb()
      .update(schema.holdingTransactions)
      .set({
        sourceMetadata: { description: 'Row 0', bankTemplate: 'monzo', format: 'csv' },
      })
      .where(eq(schema.holdingTransactions.holdingId, fixture.holdingId));

    const summary = await useCase().execute({ userId: fixture.userId });

    expect(summary.scanned).toBe(1);
    expect(summary.feesFound).toBe(0);
  });
});

async function openingBalance(holdingId: string): Promise<number | null> {
  const rows = await getDb()
    .select()
    .from(schema.holdingTransactions)
    .where(
      and(
        eq(schema.holdingTransactions.holdingId, holdingId),
        eq(schema.holdingTransactions.source, 'reconciliation-opening')
      )
    );
  return rows[0] ? Number(rows[0].quantity) : null;
}

function sumQuantities(rows: { quantity: string }[]): number {
  return rows.reduce((total, row) => total + Number(row.quantity), 0);
}

import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Container } from 'typedi';
import {
  BackupRestorer,
  backupRecords,
  RestoreRefused,
  UNMATCHED_TOKEN_MARKER,
} from '../../../src/services/backup/BackupRestorer';
import {
  type BackupRecord,
  BackupWriter,
  backupLine,
} from '../../../src/services/backup/BackupWriter';
import { BACKED_UP_TABLES } from '../../../src/services/backup/backup-plan';
import { HoldingCacheWriter } from '../../../src/services/feeds/HoldingCacheWriter';
import { TokenIdentityService } from '../../../src/services/tokens/TokenIdentityService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeUser, makeVendor } from '../../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  makePayment,
  makePaymentOccurrence,
  makeToken,
  seedReading,
} from '../../../test/helpers/factories-extra';

restoreContainerAfterAll();

/** The file as a restore reads it: every record through one NDJSON line. */
async function fileOf(userId: string, tx: DatabaseTransaction): Promise<BackupRecord[]> {
  const out: BackupRecord[] = [];
  for await (const record of new BackupWriter().records(userId, tx, 3)) {
    out.push(JSON.parse(backupLine(record)) as BackupRecord);
  }
  return out;
}

const opener = (records: BackupRecord[]) =>
  async function* () {
    yield* records;
  };

const engine = (userId: string, holdingId: string, tx: DatabaseTransaction) =>
  Container.get(HoldingCacheWriter).engineBalance(userId, holdingId, tx);

async function seedSource(tx: DatabaseTransaction) {
  const user = await makeUser(tx, { timezone: 'Asia/Singapore' });
  const institution = await makeInstitution(tx);
  const network = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  const destination = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  const shared = await makeToken(tx);
  const custom = await makeToken(tx, { createdByUserId: user.id });
  const cash = await makeHolding(tx, {
    userId: user.id,
    accountId: account.id,
    tokenId: shared.id,
  });
  const savings = await makeHolding(tx, {
    userId: user.id,
    accountId: destination.id,
    tokenId: shared.id,
  });
  const art = await makeHolding(tx, { userId: user.id, accountId: account.id, tokenId: custom.id });
  await seedReading(tx, {
    userId: user.id,
    holdingId: cash.id,
    balance: '100',
    at: new Date('2026-08-01T00:00:00Z'),
  });
  await seedReading(tx, {
    userId: user.id,
    holdingId: savings.id,
    balance: '0',
    at: new Date('2026-08-01T00:00:00Z'),
  });
  await seedReading(tx, {
    userId: user.id,
    holdingId: art.id,
    balance: '3',
    at: new Date('2026-08-01T00:00:00Z'),
  });
  const outflow = await makeHoldingTransaction(tx, {
    userId: user.id,
    holdingId: cash.id,
    tokenId: shared.id,
    kind: 'withdraw',
    quantity: '-40',
    occurredAt: new Date('2026-08-10T00:00:00Z'),
    swapGroupId: '11111111-1111-4111-8111-111111111111',
  });
  await makeHoldingTransaction(tx, {
    userId: user.id,
    holdingId: cash.id,
    tokenId: shared.id,
    kind: 'fee',
    quantity: '-1',
    occurredAt: new Date('2026-08-10T00:00:00Z'),
    settlesTransactionId: outflow.id,
    swapGroupId: '11111111-1111-4111-8111-111111111111',
  });
  const arrival = await makeHoldingTransaction(tx, {
    userId: user.id,
    holdingId: savings.id,
    tokenId: shared.id,
    kind: 'deposit',
    quantity: '39',
    occurredAt: new Date('2026-08-10T00:00:00Z'),
    externalId: outflow.id,
    sourceMetadata: { outflowTransactionId: outflow.id },
  });
  await tx
    .insert(schema.holdingCoverage)
    .values({ holdingId: cash.id, hasCompleteTxHistory: true });
  const [input] = await tx
    .insert(schema.feedInputs)
    .values({ userId: user.id, accountId: account.id, source: 'statement' })
    .returning();
  await tx.insert(schema.feedInputWindows).values({
    inputId: input?.id as string,
    fromAt: new Date('2026-08-01T00:00:00Z'),
    toAt: new Date('2026-09-01T00:00:00Z'),
    complete: true,
    fetchedAt: new Date('2026-09-01T00:00:00Z'),
    uploadRef: `temp/file-import/${user.id}/x.csv`,
  });
  await tx.insert(schema.userWallets).values({
    userId: user.id,
    walletAddress: '0xabc',
    institutionIds: [network.id],
  });
  const settledWith = await makeVendor(tx, { userId: user.id });
  const payment = await makePayment(tx, { userId: user.id, vendorId: settledWith.id });
  const occurrence = await makePaymentOccurrence(tx, {
    paymentId: payment.id,
    dueDate: '2026-08-01',
    status: 'matched',
  });
  // The bill moves to another vendor afterwards; the settled occurrence keeps the old one.
  const later = await makeVendor(tx, { userId: user.id });
  await tx
    .update(schema.payments)
    .set({ vendorId: later.id })
    .where(eq(schema.payments.id, payment.id));
  // The ledger rows above were inserted directly; the cache follows them, as
  // every production write keeps it doing.
  await Container.get(HoldingCacheWriter).refresh(user.id, [cash.id, savings.id, art.id], tx);
  return {
    user,
    shared,
    custom,
    holdings: [cash, savings, art],
    outflow,
    arrival,
    occurrence,
    settledWith,
  };
}

describe('BackupRestorer (SC-1649)', () => {
  test('restores every row into an empty account, under new ids, with equal balances', () =>
    withTestDb(async (tx) => {
      const source = await seedSource(tx);
      const records = await fileOf(source.user.id, tx);
      const target = await makeUser(tx);

      const report = await new BackupRestorer().restore(target.id, opener(records), tx);

      const end = records.at(-1);
      if (end?.type !== 'end') throw new Error('no end record');
      for (const entry of BACKED_UP_TABLES) {
        const name = getTableConfig(entry.table).name;
        expect([name, report.rows[name] ?? 0]).toEqual([name, end.counts[name] ?? 0]);
      }
      expect(report.balanceDifferences).toEqual([]);
      for (const holding of source.holdings) {
        const restored = report.ids.get(holding.id) as string;
        expect(restored).not.toBe(holding.id);
        expect(await engine(target.id, restored, tx)).toBe(
          await engine(source.user.id, holding.id, tx)
        );
      }
    }));

  test('rewrites every id the file issued, wherever it appears, and leaves no source id behind', () =>
    withTestDb(async (tx) => {
      const source = await seedSource(tx);
      const records = await fileOf(source.user.id, tx);
      const target = await makeUser(tx);
      const report = await new BackupRestorer().restore(target.id, opener(records), tx);
      const outflow = report.ids.get(source.outflow.id) as string;

      const [arrival] = await tx
        .select()
        .from(schema.holdingTransactions)
        .where(eq(schema.holdingTransactions.id, report.ids.get(source.arrival.id) as string));
      expect(arrival?.externalId).toBe(outflow);
      expect(arrival?.sourceMetadata).toEqual({ outflowTransactionId: outflow });

      const rows = await tx
        .select()
        .from(schema.holdingTransactions)
        .where(eq(schema.holdingTransactions.userId, target.id));
      const fee = rows.find((r) => r.kind === 'fee');
      expect(fee?.settlesTransactionId).toBe(outflow);
      const groups = new Set(rows.map((r) => r.swapGroupId).filter(Boolean));
      expect(groups.size).toBe(1);
      expect(groups.has('11111111-1111-4111-8111-111111111111')).toBe(false);

      // No row the target now owns names a row of the source account.
      const sourceIds = [...report.ids.keys()].filter((id) => report.ids.get(id) !== id);
      for (const entry of BACKED_UP_TABLES) {
        if (entry.owner.by !== 'user') continue;
        const owned = await tx.select().from(entry.table).where(eq(entry.owner.column, target.id));
        const text = JSON.stringify(owned);
        expect([
          getTableConfig(entry.table).name,
          sourceIds.filter((id) => text.includes(id)),
        ]).toEqual([getTableConfig(entry.table).name, []]);
      }
    }));

  test('keeps what only the file knows: history claims, settled terms, settings', () =>
    withTestDb(async (tx) => {
      const source = await seedSource(tx);
      const records = await fileOf(source.user.id, tx);
      const target = await makeUser(tx);
      const report = await new BackupRestorer().restore(target.id, opener(records), tx);

      const [coverage] = await tx
        .select()
        .from(schema.holdingCoverage)
        .where(
          eq(
            schema.holdingCoverage.holdingId,
            report.ids.get(source.holdings[0]?.id as string) as string
          )
        );
      expect(coverage?.hasCompleteTxHistory).toBe(true);

      const [occurrence] = await tx
        .select()
        .from(schema.paymentOccurrences)
        .where(eq(schema.paymentOccurrences.id, report.ids.get(source.occurrence.id) as string));
      expect(occurrence?.settledVendorId).toBe(report.ids.get(source.settledWith.id) as string);

      // A stored upload is the source account's object, so its key does not travel.
      const windows = await tx
        .select({ uploadRef: schema.feedInputWindows.uploadRef })
        .from(schema.feedInputWindows)
        .innerJoin(schema.feedInputs, eq(schema.feedInputs.id, schema.feedInputWindows.inputId))
        .where(eq(schema.feedInputs.userId, target.id));
      expect(windows).toEqual([{ uploadRef: null }]);
      const [user] = await tx.select().from(schema.users).where(eq(schema.users.id, target.id));
      expect(user?.timezone).toBe('Asia/Singapore');
      expect(user?.email).toBe(target.email);
    }));

  test('names a holding whose cache in the file disagrees with its evidence', () =>
    withTestDb(async (tx) => {
      const source = await seedSource(tx);
      const cash = source.holdings[0]?.id as string;
      const records = (await fileOf(source.user.id, tx)).map((r) =>
        r.type === 'row' && r.table === 'holdings' && r.row.id === cash
          ? { ...r, row: { ...r.row, balance: '999' } }
          : r
      );
      const target = await makeUser(tx);

      const report = await new BackupRestorer().restore(target.id, opener(records), tx);

      expect(report.balanceDifferences).toEqual([
        { holdingId: report.ids.get(cash) as string, inFile: '999', engine: '59' },
      ]);
    }));

  test('refuses an account that already has data, and writes nothing', () =>
    withTestDb(async (tx) => {
      const source = await seedSource(tx);
      const records = await fileOf(source.user.id, tx);
      const target = await makeUser(tx);
      await makeAccount(tx, { userId: target.id, institutionId: (await makeInstitution(tx)).id });

      await expect(
        new BackupRestorer().restore(target.id, opener(records), tx)
      ).rejects.toMatchObject({
        reason: 'not-empty',
      });
      const holdings = await tx
        .select()
        .from(schema.holdings)
        .where(eq(schema.holdings.userId, target.id));
      expect(holdings).toEqual([]);
    }));

  test('refuses a file cut short before writing anything', () =>
    withTestDb(async (tx) => {
      const source = await seedSource(tx);
      const records = (await fileOf(source.user.id, tx)).slice(0, -2);
      const target = await makeUser(tx);

      const refused = await new BackupRestorer()
        .restore(target.id, opener(records), tx)
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(RestoreRefused);
      expect((refused as RestoreRefused).reason).toBe('cut-short');
      const accounts = await tx
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.userId, target.id));
      expect(accounts).toEqual([]);
    }));

  test('restores a shared token this instance lacks as the account own, flagged', () =>
    withTestDb(async (tx) => {
      const source = await seedSource(tx);
      // The file as another instance wrote it: its shared token is one this instance never had.
      const unknown = '22222222-2222-4222-8222-222222222222';
      const rewired = (
        JSON.parse(
          JSON.stringify(await fileOf(source.user.id, tx)).replaceAll(source.shared.id, unknown)
        ) as BackupRecord[]
      ).map((r) =>
        r.type === 'catalog' && r.table === 'tokens' && r.row.id === unknown
          ? { ...r, row: { ...r.row, symbol: 'ZZNOPE' } }
          : r
      );
      Container.set(TokenIdentityService, {
        findOrCreateByIdentity: async () => {
          throw new Error('no provider knows this token');
        },
      } as unknown as TokenIdentityService);
      const target = await makeUser(tx);

      const report = await new BackupRestorer().restore(target.id, opener(rewired), tx);

      expect(report.unmatchedTokens).toBe(1);
      const restored = report.ids.get(unknown) as string;
      const [token] = await tx.select().from(schema.tokens).where(eq(schema.tokens.id, restored));
      expect(token?.createdByUserId).toBe(target.id);
      expect(token?.symbol).toBe('ZZNOPE');
      expect(token?.providerMetadata).toMatchObject({ [UNMATCHED_TOKEN_MARKER]: true });
      const onIt = await tx
        .select()
        .from(schema.holdings)
        .where(eq(schema.holdings.tokenId, restored));
      expect(onIt.length).toBe(2);
      // The control: the custom token the account owned is restored as its own, unflagged.
      const [custom] = await tx
        .select()
        .from(schema.tokens)
        .where(eq(schema.tokens.id, report.ids.get(source.custom.id) as string));
      expect(
        (custom?.providerMetadata as Record<string, unknown> | null)?.[UNMATCHED_TOKEN_MARKER]
      ).toBeUndefined();
    }));
});

describe('BackupRestorer categories (SC-1652)', () => {
  test("keeps a parent, its child, and a row's category, under new ids", () =>
    withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const row = await makeHoldingTransaction(tx, { userId: user.id });
      const [bills] = await tx
        .insert(schema.transactionCategories)
        .values({ userId: user.id, name: 'Bills' })
        .returning();
      const [rent] = await tx
        .insert(schema.transactionCategories)
        .values({ userId: user.id, name: 'Rent', parentId: bills!.id })
        .returning();
      await tx
        .update(schema.holdingTransactions)
        .set({ categoryId: rent!.id, categorySetBy: 'person' })
        .where(eq(schema.holdingTransactions.id, row.id));
      const records = await fileOf(user.id, tx);
      const target = await makeUser(tx);

      const report = await new BackupRestorer().restore(target.id, opener(records), tx);

      const restored = await tx
        .select()
        .from(schema.transactionCategories)
        .where(eq(schema.transactionCategories.userId, target.id));
      const parent = restored.find((c) => c.name === 'Bills');
      const child = restored.find((c) => c.name === 'Rent');
      expect(parent?.id).not.toBe(bills!.id);
      expect(child?.parentId).toBe(parent!.id);
      const [moved] = await tx
        .select({
          categoryId: schema.holdingTransactions.categoryId,
          by: schema.holdingTransactions.categorySetBy,
        })
        .from(schema.holdingTransactions)
        .where(eq(schema.holdingTransactions.id, report.ids.get(row.id) as string));
      expect(moved).toEqual({ categoryId: child!.id, by: 'person' });
    }));
});

describe('backupRecords (SC-1649)', () => {
  const read = async (bytes: Uint8Array) => {
    const out: unknown[] = [];
    for await (const record of backupRecords(bytes)) out.push(record);
    return out;
  };

  test('reads a gzipped file one record per line, across chunk boundaries', async () => {
    const records = Array.from({ length: 2000 }, (_, i) => ({
      type: 'row',
      table: 't',
      row: { i },
    }));
    const gz = Bun.gzipSync(
      new TextEncoder().encode(records.map((r) => JSON.stringify(r)).join('\n'))
    );
    expect(await read(gz)).toEqual(records);
  });

  test('refuses bytes that are not gzip, and a line that is not JSON', async () => {
    const notGzip = await read(new TextEncoder().encode('hello')).catch((e: unknown) => e);
    expect((notGzip as RestoreRefused).reason).toBe('not-a-backup');
    const notJson = await read(
      Bun.gzipSync(new TextEncoder().encode('{"type":"header"}\nnope'))
    ).catch((e: unknown) => e);
    expect((notJson as RestoreRefused).reason).toBe('not-a-backup');
  });
});

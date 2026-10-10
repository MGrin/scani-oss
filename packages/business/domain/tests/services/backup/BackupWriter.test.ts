import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import {
  type BackupRecord,
  BackupWriter,
  backupLine,
} from '../../../src/services/backup/BackupWriter';
import { BACKED_UP_USER_COLUMNS } from '../../../src/services/backup/backup-plan';
import { withTestDb } from '../../../test/helpers/db';
import {
  makeCredential,
  makeDocument,
  makeInstitution,
  makeUser,
} from '../../../test/helpers/factories';
import {
  makeAccount,
  makeCheckpoint,
  makeHolding,
  makeHoldingTransaction,
  makeToken,
} from '../../../test/helpers/factories-extra';

async function collect(gen: AsyncGenerator<BackupRecord>): Promise<BackupRecord[]> {
  const out: BackupRecord[] = [];
  for await (const record of gen) out.push(record);
  return out;
}

const rowIds = (records: BackupRecord[], table: string) =>
  records.flatMap((r) => (r.type === 'row' && r.table === table ? [r.row.id] : []));
const catalogIds = (records: BackupRecord[], table: string) =>
  records.flatMap((r) => (r.type === 'catalog' && r.table === table ? [r.row.id] : []));

async function seedAccount(tx: DatabaseTransaction) {
  const user = await makeUser(tx);
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  const shared = await makeToken(tx);
  const custom = await makeToken(tx, { createdByUserId: user.id });
  const holding = await makeHolding(tx, {
    userId: user.id,
    accountId: account.id,
    tokenId: shared.id,
  });
  const customHolding = await makeHolding(tx, {
    userId: user.id,
    accountId: account.id,
    tokenId: custom.id,
  });
  const entries = [];
  for (let i = 0; i < 5; i++) {
    entries.push(
      await makeHoldingTransaction(tx, {
        userId: user.id,
        holdingId: holding.id,
        tokenId: shared.id,
      })
    );
  }
  const reading = await makeCheckpoint(tx, {
    userId: user.id,
    holdingId: holding.id,
    observedAt: new Date('2026-09-01T00:00:00Z'),
    balance: '5',
  });
  const [input] = await tx
    .insert(schema.feedInputs)
    .values({ userId: user.id, accountId: account.id, source: 'statement' })
    .returning();
  const [window] = await tx
    .insert(schema.feedInputWindows)
    .values({
      inputId: input?.id as string,
      fromAt: new Date('2026-08-01T00:00:00Z'),
      toAt: new Date('2026-09-01T00:00:00Z'),
      complete: true,
      fetchedAt: new Date('2026-09-01T00:00:00Z'),
    })
    .returning();
  const credential = await makeCredential(tx, { userId: user.id, institutionId: institution.id });
  const document = await makeDocument(tx, { userId: user.id });
  return {
    user,
    institution,
    account,
    shared,
    custom,
    holdings: [holding.id, customHolding.id],
    entries: entries.map((e) => e.id),
    reading,
    input,
    window,
    credential,
    document,
  };
}

describe('BackupWriter (SC-1649)', () => {
  test('carries every backed-up row of the account once, across pages, and nothing of another', () =>
    withTestDb(async (tx) => {
      const mine = await seedAccount(tx);
      const theirs = await seedAccount(tx);

      const records = await collect(new BackupWriter().records(mine.user.id, tx, 2));

      expect([...rowIds(records, 'holdings')].sort()).toEqual([...mine.holdings].sort());
      expect([...rowIds(records, 'holding_transactions')].sort()).toEqual([...mine.entries].sort());
      expect(rowIds(records, 'holding_balance_observations')).toEqual([mine.reading.id]);
      expect(rowIds(records, 'feed_inputs')).toEqual([mine.input?.id]);
      expect(rowIds(records, 'feed_input_windows')).toEqual([mine.window?.id]);
      expect(rowIds(records, 'accounts')).toEqual([mine.account.id]);
      expect(rowIds(records, 'tokens')).toEqual([mine.custom.id]);

      const theirIds = new Set<unknown>([
        theirs.account.id,
        ...theirs.holdings,
        ...theirs.entries,
        theirs.reading.id,
        theirs.input?.id,
        theirs.custom.id,
      ]);
      expect(records.filter((r) => r.type === 'row' && theirIds.has(r.row.id))).toEqual([]);
    }));

  test('leaves out credentials and documents, and carries no user column it should not', () =>
    withTestDb(async (tx) => {
      const mine = await seedAccount(tx);
      const records = await collect(new BackupWriter().records(mine.user.id, tx));

      const tables = new Set(records.flatMap((r) => (r.type === 'row' ? [r.table] : [])));
      expect(tables.has('user_integration_credentials')).toBe(false);
      expect(tables.has('documents')).toBe(false);
      // The control: the same read does see a table that is carried.
      expect(tables.has('holdings')).toBe(true);

      const user = records.find((r) => r.type === 'user');
      expect(Object.keys(user?.type === 'user' ? user.row : {}).sort()).toEqual(
        [...BACKED_UP_USER_COLUMNS].sort()
      );
      expect(JSON.stringify(records)).not.toContain(mine.user.email);
    }));

  test('names the shared rows it references as catalog, before the rows that use them', () =>
    withTestDb(async (tx) => {
      const mine = await seedAccount(tx);
      const records = await collect(new BackupWriter().records(mine.user.id, tx));

      expect(catalogIds(records, 'tokens')).toContain(mine.shared.id);
      expect(catalogIds(records, 'tokens')).not.toContain(mine.custom.id);
      expect(catalogIds(records, 'token_types')).toEqual(
        expect.arrayContaining([mine.shared.typeId, mine.custom.typeId])
      );
      expect(catalogIds(records, 'institutions')).toContain(mine.institution.id);

      const order = records.map((r) => (r.type === 'catalog' ? `catalog:${r.table}` : r.type));
      const last = (kind: string) => order.lastIndexOf(kind);
      const first = (kind: string) => order.indexOf(kind);
      expect(last('catalog:token_types')).toBeLessThan(first('catalog:tokens'));
      expect(last('catalog:tokens')).toBeLessThan(first('user'));
      expect(first('user')).toBeLessThan(first('row'));
    }));

  test('carries holding coverage, whose history claims nothing else records', () =>
    withTestDb(async (tx) => {
      const mine = await seedAccount(tx);
      const [holdingId] = mine.holdings;
      await tx
        .insert(schema.holdingCoverage)
        .values({ holdingId: holdingId as string, hasCompleteTxHistory: true });
      const records = await collect(new BackupWriter().records(mine.user.id, tx));

      const coverage = records.flatMap((r) =>
        r.type === 'row' && r.table === 'holding_coverage' ? [r.row] : []
      );
      expect(coverage).toEqual([
        expect.objectContaining({ holdingId, hasCompleteTxHistory: true }),
      ]);
      const header = records[0];
      const left = header?.type === 'header' ? header.notIncluded.map((n) => n.table) : [];
      expect(left).not.toContain('holding_coverage');
      // The control: a derived table is still left out.
      expect(left).toContain('portfolio_value_daily');
    }));

  test('names an institution a wallet lists only in its JSON as catalog', () =>
    withTestDb(async (tx) => {
      const mine = await seedAccount(tx);
      const network = await makeInstitution(tx);
      await tx.insert(schema.userWallets).values({
        userId: mine.user.id,
        walletAddress: '0xabc',
        institutionIds: [network.id],
      });
      const records = await collect(new BackupWriter().records(mine.user.id, tx));

      expect(catalogIds(records, 'institutions')).toEqual(
        expect.arrayContaining([network.id, mine.institution.id])
      );
    }));

  test('opens with a header and closes with counts that match what it wrote', () =>
    withTestDb(async (tx) => {
      const mine = await seedAccount(tx);
      const records = await collect(new BackupWriter().records(mine.user.id, tx, 2));

      expect(records[0]).toMatchObject({ type: 'header', format: 'scani-backup', version: 1 });
      const header = records[0];
      const left = header?.type === 'header' ? header.notIncluded.map((n) => n.table) : [];
      expect(left).toContain('documents');
      expect(left).not.toContain('holdings');
      const end = records.at(-1);
      if (end?.type !== 'end') throw new Error('no end record');
      expect(end.records).toBe(records.length);
      expect(end.counts.holding_transactions).toBe(5);
      const rows = records.filter((r) => r.type === 'row').length;
      const counted = Object.entries(end.counts)
        .filter(([table]) => !table.startsWith('catalog:'))
        .reduce((sum, [, n]) => sum + n, 0);
      expect(counted).toBe(rows);
    }));

  test('writes one line per record and survives a bigint', () => {
    const line = backupLine({ type: 'row', table: 't', row: { n: 10n } });
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({ type: 'row', table: 't', row: { n: '10' } });
  });
});

describe('BackupWriter.file (SC-1649)', () => {
  test('gzips one line per record, ends with the end record, and hashes the bytes', () =>
    withTestDb(async (tx) => {
      const mine = await seedAccount(tx);
      const file = await new BackupWriter().file(mine.user.id, tx);

      const lines = new TextDecoder()
        .decode(Bun.gunzipSync(file.bytes))
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as BackupRecord);
      expect(lines[0]?.type).toBe('header');
      expect(lines.at(-1)).toMatchObject({ type: 'end', records: lines.length });
      expect(file.records).toBe(lines.length);
      expect(file.counts.holding_transactions).toBe(5);
      expect(file.sha256).toBe(createHash('sha256').update(file.bytes).digest('hex'));
    }));
});

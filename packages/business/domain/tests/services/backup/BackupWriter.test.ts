import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import {
  type BackupFileSource,
  type BackupRecord,
  BackupWriter,
  backupLine,
} from '../../../src/services/backup/BackupWriter';
import { BACKED_UP_USER_COLUMNS } from '../../../src/services/backup/backup-plan';
import { withTestDb } from '../../../test/helpers/db';
import {
  makeCredential,
  makeDocument,
  makeDocumentExtraction,
  makeInstitution,
  makeUser,
  makeVendor,
} from '../../../test/helpers/factories';
import {
  makeAccount,
  makeCheckpoint,
  makeHolding,
  makeHoldingTransaction,
  makePayment,
  makePaymentOccurrence,
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

      expect(records[0]).toMatchObject({ type: 'header', format: 'scani-backup', version: 2 });
      const header = records[0];
      const left = header?.type === 'header' ? header.notIncluded.map((n) => n.table) : [];
      expect(left).toContain('user_integration_credentials');
      expect(left).not.toContain('documents');
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

/** Stored files by key, as a backup reads them. */
function memoryFiles(stored: Map<string, Uint8Array>): BackupFileSource {
  return {
    exists: async (key) => stored.has(key),
    read: async (key) => {
      const bytes = stored.get(key);
      if (!bytes) throw new Error(`no object ${key}`);
      return bytes;
    },
  };
}

async function seedDocuments(tx: DatabaseTransaction) {
  const user = await makeUser(tx);
  const vendor = await makeVendor(tx, { userId: user.id });
  const stored = await makeDocument(tx, {
    userId: user.id,
    r2Key: `documents/${user.id}/stored.pdf`,
    originalFilename: 'march.pdf',
    byteSize: 5,
  });
  const temp = await makeDocument(tx, {
    userId: user.id,
    r2Key: `temp/document/${user.id}/never-kept.png`,
    originalFilename: 'screenshot.png',
    mimeType: 'image/png',
    byteSize: 7,
  });
  const gone = await makeDocument(tx, {
    userId: user.id,
    r2Key: `documents/${user.id}/gone.pdf`,
    originalFilename: 'april.pdf',
    byteSize: 9,
  });
  const kept = await makeDocumentExtraction(tx, { documentId: stored.id, vendorId: vendor.id });
  const dropped = await makeDocumentExtraction(tx, { documentId: temp.id });
  const payment = await makePayment(tx, { userId: user.id, vendorId: vendor.id });
  const matchedKept = await makePaymentOccurrence(tx, {
    paymentId: payment.id,
    dueDate: '2026-08-01',
    status: 'matched',
    matchedExtractionId: kept.id,
  });
  const matchedDropped = await makePaymentOccurrence(tx, {
    paymentId: payment.id,
    dueDate: '2026-09-01',
    status: 'matched',
    matchedExtractionId: dropped.id,
  });
  const bytes = new Uint8Array([37, 80, 68, 70, 45]);
  const files = new Map([[stored.r2Key, bytes]]);
  return { user, stored, temp, gone, kept, dropped, matchedKept, matchedDropped, bytes, files };
}

const occurrence = (records: BackupRecord[], id: string) =>
  records.find((r) => r.type === 'row' && r.table === 'payment_occurrences' && r.row.id === id);

describe('BackupWriter uploaded documents (SC-1662)', () => {
  test('carries a stored document, its extraction and its file, and names the ones it cannot', () =>
    withTestDb(async (tx) => {
      const s = await seedDocuments(tx);
      const records = await collect(
        new BackupWriter().records(s.user.id, tx, 1000, memoryFiles(s.files))
      );

      expect(rowIds(records, 'documents')).toEqual([s.stored.id]);
      expect(rowIds(records, 'document_extractions')).toEqual([s.kept.id]);
      const files = records.filter((r) => r.type === 'file');
      expect(files).toHaveLength(1);
      const file = files[0];
      if (file?.type !== 'file') throw new Error('no file record');
      expect(file.documentId).toBe(s.stored.id);
      expect(new Uint8Array(Buffer.from(file.data, 'base64'))).toEqual(s.bytes);
      expect(file.sha256).toBe(createHash('sha256').update(s.bytes).digest('hex'));
      // Every file follows its document's row, so a restore knows where to put it.
      const at = (pred: (r: BackupRecord) => boolean) => records.findIndex(pred);
      expect(at((r) => r.type === 'file')).toBeGreaterThan(
        at((r) => r.type === 'row' && r.table === 'documents')
      );

      const header = records[0];
      if (header?.type !== 'header' || !header.files) throw new Error('no header with files');
      expect(header.files.included).toBe(true);
      expect(
        [...header.files.omitted].sort((a, b) => a.filename.localeCompare(b.filename))
      ).toEqual([
        { documentId: s.gone.id, filename: 'april.pdf', byteSize: 9, reason: 'not-stored' },
        { documentId: s.temp.id, filename: 'screenshot.png', byteSize: 7, reason: 'not-stored' },
      ]);

      // A bill matched to a left-out extraction keeps the match on this side only.
      const kept = occurrence(records, s.matchedKept.id);
      const dropped = occurrence(records, s.matchedDropped.id);
      expect(kept?.type === 'row' ? kept.row.matchedExtractionId : 'missing').toBe(s.kept.id);
      expect(dropped?.type === 'row' ? dropped.row.matchedExtractionId : 'missing').toBeNull();

      const end = records.at(-1);
      if (end?.type !== 'end') throw new Error('no end record');
      expect(end.counts.files).toBe(1);
      expect(end.records).toBe(records.length);
    }));

  // SC-1656: a statement window names the file it was read from. Like a bill
  // matched to a left-out extraction, it keeps that link on the source only.
  test('a statement window keeps the link to a carried document, and loses one to a left-out document', () =>
    withTestDb(async (tx) => {
      const s = await seedDocuments(tx);
      const institution = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: s.user.id, institutionId: institution.id });
      const [input] = await tx
        .insert(schema.feedInputs)
        .values({ userId: s.user.id, accountId: account.id, source: 'statement' })
        .returning();
      const window = async (documentId: string, day: string) => {
        const [row] = await tx
          .insert(schema.feedInputWindows)
          .values({
            inputId: input!.id,
            fromAt: new Date(`${day}T00:00:00Z`),
            toAt: new Date(`${day}T12:00:00Z`),
            complete: false,
            fetchedAt: new Date(`${day}T13:00:00Z`),
            uploadRef: 'temp/file-import/statement.csv',
            documentId,
            shape: 'statement-upload',
          })
          .returning();
        return row!.id;
      };
      const toStored = await window(s.stored.id, '2026-08-01');
      const toTemp = await window(s.temp.id, '2026-09-01');

      const records = await collect(
        new BackupWriter().records(s.user.id, tx, 1000, memoryFiles(s.files))
      );
      const linkOf = (id: string) => {
        const record = records.find(
          (r) => r.type === 'row' && r.table === 'feed_input_windows' && r.row.id === id
        );
        return record?.type === 'row' ? record.row.documentId : 'missing';
      };
      expect(linkOf(toStored)).toBe(s.stored.id);
      expect(linkOf(toTemp)).toBeNull();
    }));

  test('without its files, it carries no document and names every one as too large', () =>
    withTestDb(async (tx) => {
      const s = await seedDocuments(tx);
      const records = await collect(new BackupWriter().records(s.user.id, tx));

      expect(rowIds(records, 'documents')).toEqual([]);
      expect(rowIds(records, 'document_extractions')).toEqual([]);
      expect(records.filter((r) => r.type === 'file')).toEqual([]);
      const header = records[0];
      if (header?.type !== 'header' || !header.files) throw new Error('no header with files');
      expect(header.files.included).toBe(false);
      expect(header.files.omitted.map((o) => [o.documentId, o.reason]).sort()).toEqual(
        [
          [s.stored.id, 'too-large'],
          [s.temp.id, 'too-large'],
          [s.gone.id, 'too-large'],
        ].sort()
      );
      const kept = occurrence(records, s.matchedKept.id);
      expect(kept?.type === 'row' ? kept.row.matchedExtractionId : 'missing').toBeNull();
      // The control: the rest of the account is still carried.
      expect(rowIds(records, 'payment_occurrences')).toHaveLength(2);
    }));

  test('file() says how many files it carried and how many it left out as too large', () =>
    withTestDb(async (tx) => {
      const s = await seedDocuments(tx);
      const writer = new BackupWriter();
      const withFiles = await writer.file(s.user.id, tx, memoryFiles(s.files));
      expect([withFiles.filesIncluded, withFiles.filesLeftOut]).toEqual([1, 0]);
      const without = await writer.file(s.user.id, tx);
      expect([without.filesIncluded, without.filesLeftOut]).toEqual([0, 3]);
    }));
});

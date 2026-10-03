/**
 * The statement import end to end against Postgres. Only the object store, the
 * column-detection model, the queue and the job row are stubbed, so every row,
 * observation, balance and warning asserted here is what the processor wrote.
 *
 * Fixtures are committed rather than rolled back: the processor opens its own
 * connections, and history and classification read committed rows.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import { getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { TokenRepository, UserJobRepository } from '@scani/domain/repositories';
import {
  CsvColumnDetectionService,
  DocumentRetentionService,
  FoundationClassificationService,
  TransferReviewService,
  UploadedFileService,
} from '@scani/domain/services';
import {
  captureHistory,
  expectLabelsSettled,
  makeAccount,
  makeHolding,
  makeInstitution,
  makeInstitutionType,
  makeToken,
  makeUser,
  restoreContainerAfterAll,
} from '@scani/domain/test-helpers';
import type { FileImportJob, PortfolioHistoryBackfillJob } from '@scani/jobs';
import { BullMqEnqueueService, type ProcessorContext } from '@scani/queue';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { FileImportProcessor } from '../../src/processors/file-import';

restoreContainerAfterAll();

const objects = new Map<string, Buffer>();
const enqueued: PortfolioHistoryBackfillJob[] = [];
const marked: Array<[userId: string, jobId: string]> = [];

Container.set(StorageFacade, {
  read: async (key: string) => {
    const found = objects.get(key);
    if (!found) throw new Error(`no object at ${key}`);
    return found;
  },
  write: async (key: string, bytes: Uint8Array) => {
    objects.set(key, Buffer.from(bytes));
  },
} as unknown as StorageFacade);
// Rebuilt over the stubbed store, so an upload is recorded and retained for real.
Container.set(DocumentRetentionService, new DocumentRetentionService());
Container.set(UploadedFileService, new UploadedFileService());
Container.set(CsvColumnDetectionService, {
  detectColumns: async () => null,
} as unknown as CsvColumnDetectionService);
Container.set(BullMqEnqueueService, {
  add: async (_descriptor: unknown, data: PortfolioHistoryBackfillJob) => {
    enqueued.push(data);
    return 'queued';
  },
} as unknown as BullMqEnqueueService);
Container.set(UserJobRepository, {
  markActionTaken: async (userId: string, jobId: string) => {
    marked.push([userId, jobId]);
  },
} as unknown as UserJobRepository);

class TestableProcessor extends FileImportProcessor {
  run(data: FileImportJob, ctx: ProcessorContext) {
    return this.handle(data, ctx);
  }
}

const MANUAL_AT = new Date('2026-07-15T00:00:00Z');
const CLOSE_AT = new Date('2026-08-06T18:00:00Z');
const DAY_MS = 86_400_000;

const HEADER =
  'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance,id';

interface Line {
  at: string;
  description: string;
  amount: string;
  currency: string;
  fee?: string;
  balance?: string;
  id?: string;
}

/** A Revolut-shaped export. Its dates carry a `Z`, so they parse alike in every time zone. */
const csvOf = (lines: readonly Line[]) =>
  [
    HEADER,
    ...lines.map((l) =>
      [
        'CARD_PAYMENT',
        'Current',
        l.at,
        l.at,
        l.description,
        l.amount,
        l.fee ?? '0.00',
        l.currency,
        'COMPLETED',
        l.balance ?? '',
        l.id ?? '',
      ].join(',')
    ),
  ].join('\n');

/** Short enough for the job schema's `defaultCurrency`, and still unique per run. */
const symbol = (prefix: string) =>
  `${prefix}${randomUUID().replace(/-/g, '').slice(0, 7).toUpperCase()}`;

const unknownWarning = (currency: string) =>
  `Unknown currency '${currency}' — statement rows for this currency skipped`;

/**
 * A row date counted back from today. The rebuild's reach is counted from now,
 * so a fixed date is a different number of days on another day; the half day
 * keeps the count off a day's edge.
 */
const daysAgo = (days: number) => {
  const at = new Date(Date.now() - days * DAY_MS);
  at.setUTCMilliseconds(0);
  return at.toISOString();
};

/** Nine rows in three currencies: `closed` ends on a balance, `unclosed` has none, one is unknown. */
const twoCurrencyStatement = (closed: string, unclosed: string, unknown: string): Line[] => [
  {
    at: '2026-08-01T10:00:00Z',
    description: 'Salary ACME',
    amount: '1000.00',
    currency: closed,
    balance: '1000.00',
  },
  {
    at: '2026-08-02T09:00:00Z',
    description: 'Cash at ATM',
    amount: '-120.00',
    fee: '1.50',
    currency: closed,
    balance: '878.50',
  },
  { at: '2026-08-03T12:00:00Z', description: 'Shop B', amount: '-20.00', currency: unclosed },
  { at: '2026-08-03T13:00:00Z', description: 'Top up B', amount: '50.00', currency: unclosed },
  { at: '2026-08-04T08:00:00Z', description: 'Mystery', amount: '-5.00', currency: unknown },
  { at: '2026-08-04T09:00:00Z', description: 'Mystery two', amount: '-6.00', currency: unknown },
  {
    at: '2026-08-05T10:00:00Z',
    description: 'Repeated',
    amount: '-10.00',
    currency: closed,
    balance: '868.50',
    id: 'dup-1',
  },
  {
    at: '2026-08-05T10:00:00Z',
    description: 'Repeated',
    amount: '-10.00',
    currency: closed,
    balance: '858.50',
    id: 'dup-1',
  },
  {
    at: '2026-08-06T18:00:00Z',
    description: 'Coffee',
    amount: '-3.50',
    currency: closed,
    balance: '855.00',
  },
];

const holdings = schema.holdings;
const ledger = schema.holdingTransactions;
const observations = schema.holdingBalanceObservations;

const holdingsOf = (accountId: string) =>
  getDb()
    .select()
    .from(holdings)
    .where(eq(holdings.accountId, accountId))
    .orderBy(asc(holdings.createdAt), asc(holdings.id));

const ledgerOf = (userId: string) =>
  getDb()
    .select()
    .from(ledger)
    .where(eq(ledger.userId, userId))
    .orderBy(asc(ledger.occurredAt), asc(ledger.externalId));

/** Closes before copies, then by amount: two copies written a millisecond apart have no order of their own. */
const observationsOf = async (userId: string) =>
  (await getDb().select().from(observations).where(eq(observations.userId, userId))).sort(
    (a, b) => a.source.localeCompare(b.source) || Number(a.balance) - Number(b.balance)
  );

const copiesOf = async (userId: string) =>
  (await observationsOf(userId)).filter(
    (o) =>
      o.source === 'sync-capture' &&
      (o.sourceMetadata as { origin?: string }).origin === 'updateHoldingBalance'
  );

const documentsOf = (userId: string) =>
  getDb()
    .select()
    .from(schema.documents)
    .where(eq(schema.documents.userId, userId))
    .orderBy(asc(schema.documents.createdAt));

const inputsOf = (accountId: string) =>
  getDb().select().from(schema.feedInputs).where(eq(schema.feedInputs.accountId, accountId));

/** Each window of the account's inputs, oldest fetch first, without its own id. */
const windowsOf = async (accountId: string) =>
  (
    await getDb()
      .select({ window: schema.feedInputWindows })
      .from(schema.feedInputWindows)
      .innerJoin(schema.feedInputs, eq(schema.feedInputWindows.inputId, schema.feedInputs.id))
      .where(eq(schema.feedInputs.accountId, accountId))
      .orderBy(asc(schema.feedInputWindows.fetchedAt))
  ).map(({ window: { id: _id, ...window } }) => window);

describe('FileImportProcessor', () => {
  const created = { users: [] as string[], tokens: [] as string[], institutions: [] as string[] };
  let disposalMarks: ReturnType<typeof spyOn>;

  beforeEach(() => {
    disposalMarks = spyOn(Container.get(TransferReviewService), 'applyDisposalMarks');
  });

  afterEach(async () => {
    disposalMarks.mockRestore();
    objects.clear();
    enqueued.length = 0;
    marked.length = 0;
    const db = getDb();
    const users = created.users.splice(0);
    const tokens = created.tokens.splice(0);
    const institutions = created.institutions.splice(0);
    // Users first: their holdings are what keep the tokens restricted.
    if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
    if (tokens.length) await db.delete(schema.tokens).where(inArray(schema.tokens.id, tokens));
    if (institutions.length) {
      await db.delete(schema.institutions).where(inArray(schema.institutions.id, institutions));
    }
  });

  /** A user with one bank account and a catalog token per prefix asked for. */
  async function seed<const P extends readonly string[]>(...prefixes: P) {
    const fixture = await getDb().transaction(async (tx) => {
      // The seeded type, upserted, so no `institution_types` row outlives the test.
      const bank = await makeInstitutionType(tx, { code: 'bank' });
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx, { typeId: bank.id });
      const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const tokens = [];
      for (const prefix of prefixes) {
        tokens.push(await makeToken(tx, { symbol: symbol(prefix), name: `Token ${prefix}` }));
      }
      return {
        userId: user.id,
        accountId: account.id,
        institutionId: institution.id,
        tokens: tokens as { [K in keyof P]: typeof schema.tokens.$inferSelect },
      };
    });
    created.users.push(fixture.userId);
    created.tokens.push(...fixture.tokens.map((t) => t.id));
    created.institutions.push(fixture.institutionId);
    return fixture;
  }

  /** A holding a person keeps by hand, with the value they typed, already classified. */
  async function manualHolding(owner: { userId: string; accountId: string }, tokenId: string) {
    const holding = await getDb().transaction(async (tx) => {
      const made = await makeHolding(tx, {
        userId: owner.userId,
        accountId: owner.accountId,
        tokenId,
        balance: '700',
        source: 'manual',
        createdAt: MANUAL_AT,
        lastUpdated: MANUAL_AT,
      });
      await tx.insert(observations).values({
        userId: owner.userId,
        holdingId: made.id,
        balance: '700',
        observedAt: MANUAL_AT,
        source: 'sync-capture',
        sourceMetadata: { origin: 'createHoldingWithEvent', source: 'manual' },
      });
      return made;
    });
    await Container.get(FoundationClassificationService).classify({
      apply: true,
      userId: owner.userId,
    });
    return holding;
  }

  function upload(
    owner: { userId: string; accountId: string },
    csv: string,
    fields: Partial<FileImportJob> = {}
  ): FileImportJob {
    const r2Key = `temp/file-import/${owner.userId}/${randomUUID()}.csv`;
    objects.set(r2Key, Buffer.from(csv));
    return {
      userId: owner.userId,
      requestId: randomUUID(),
      r2Key,
      originalFilename: 'statement.csv',
      fileType: 'csv',
      accountId: owner.accountId,
      enrich: true,
      ...fields,
    };
  }

  async function run(job: FileImportJob) {
    const statuses: string[] = [];
    const jobId = `job-${randomUUID()}`;
    const result = await new TestableProcessor().run(job, {
      job: { id: jobId },
      reportProgress: async () => undefined,
      reportStatus: async (status: string) => {
        statuses.push(status);
      },
    } as unknown as ProcessorContext);
    return { result, statuses, jobId };
  }

  /** The fixture most tests share: a manual holding of `closed`, and no holding of `unclosed`. */
  async function twoCurrencies() {
    const fixture = await seed('A', 'B');
    const [closed, unclosed] = fixture.tokens;
    const manual = await manualHolding(fixture, closed.id);
    const unknown = symbol('Z');
    const csv = csvOf(twoCurrencyStatement(closed.symbol, unclosed.symbol, unknown));
    return { fixture, closed, unclosed, manual, unknown, csv };
  }

  test('a two-currency statement: its rows, its close, each cache and its copy, the window, the warnings, the summary and the follow-ups', async () => {
    const { fixture, closed, unclosed, manual, unknown, csv } = await twoCurrencies();
    const job = upload(fixture, csv);

    const { result, statuses, jobId } = await run(job);

    const [, made] = await holdingsOf(fixture.accountId);
    if (!made) throw new Error('the import created no holding');
    const [input] = await inputsOf(fixture.accountId);
    if (!input) throw new Error('the import created no statement input');
    const nameOf = (holdingId: string) =>
      holdingId === manual.id ? 'closed' : holdingId === made.id ? 'unclosed' : holdingId;

    expect(
      (await holdingsOf(fixture.accountId)).map((h) => ({
        holding: nameOf(h.id),
        tokenId: h.tokenId,
        balance: h.balance,
        source: h.source,
        arrival: h.arrival,
        externalId: h.externalId,
        kind: h.kind,
      }))
    ).toEqual([
      {
        holding: 'closed',
        tokenId: closed.id,
        balance: '855',
        source: 'manual',
        arrival: manual.arrival,
        externalId: null,
        kind: 'feed',
      },
      {
        holding: 'unclosed',
        tokenId: unclosed.id,
        balance: '30',
        source: 'statement-import',
        arrival: 'user_confirmed',
        externalId: null,
        kind: 'feed',
      },
    ]);

    expect(
      (await ledgerOf(fixture.userId)).map((r) => [
        r.externalId,
        nameOf(r.holdingId),
        r.kind,
        r.quantity,
        r.source,
      ])
    ).toEqual([
      [
        'synthetic:2026-08-01T10:00:00:1000:Salary ACME:1',
        'closed',
        'deposit',
        '1000',
        'statement-csv',
      ],
      [
        'synthetic:2026-08-02T09:00:00:-120:Cash at ATM:2',
        'closed',
        'withdraw',
        '-120',
        'statement-csv',
      ],
      [
        'synthetic:2026-08-02T09:00:00:-120:Cash at ATM:2:fee',
        'closed',
        'fee',
        '-1.5',
        'statement-csv',
      ],
      [
        'synthetic:2026-08-03T12:00:00:-20:Shop B:3',
        'unclosed',
        'withdraw',
        '-20',
        'statement-csv',
      ],
      ['synthetic:2026-08-03T13:00:00:50:Top up B:4', 'unclosed', 'deposit', '50', 'statement-csv'],
      ['natural:dup-1', 'closed', 'withdraw', '-10', 'statement-csv'],
      [
        'synthetic:2026-08-06T18:00:00:-3.5:Coffee:9',
        'closed',
        'withdraw',
        '-3.5',
        'statement-csv',
      ],
    ]);
    expect([...new Set((await ledgerOf(fixture.userId)).map((r) => r.inputId))]).toEqual([
      input.id,
    ]);

    const written = (await observationsOf(fixture.userId)).filter(
      (o) => o.observedAt.getTime() !== MANUAL_AT.getTime()
    );
    expect(
      written.map((o) => ({
        holding: nameOf(o.holdingId),
        balance: o.balance,
        source: o.source,
        sourceMetadata: o.sourceMetadata,
        role: o.role,
        authority: o.authority,
        inputId: o.inputId,
        atTheClose: o.observedAt.getTime() === CLOSE_AT.getTime(),
      }))
    ).toEqual([
      {
        holding: 'closed',
        balance: '855',
        source: 'statement-close',
        sourceMetadata: { format: 'csv', bankTemplate: 'revolut' },
        role: 'checkpoint',
        authority: 'statement',
        inputId: input.id,
        atTheClose: true,
      },
      // The sync-capture copy is still written beside each balance write,
      // stamped at the import and unlabelled; only its marker is new.
      {
        holding: 'unclosed',
        balance: '30',
        source: 'sync-capture',
        sourceMetadata: { origin: 'updateHoldingBalance', legacyAnchor: 'file-import' },
        role: null,
        authority: null,
        inputId: null,
        atTheClose: false,
      },
      {
        holding: 'closed',
        balance: '855',
        source: 'sync-capture',
        sourceMetadata: { origin: 'updateHoldingBalance', legacyAnchor: 'file-import' },
        role: null,
        authority: null,
        inputId: null,
        atTheClose: false,
      },
    ]);

    const [document] = await documentsOf(fixture.userId);
    expect({
      input: {
        userId: input.userId,
        source: input.source,
        credentialId: input.credentialId,
        walletId: input.walletId,
      },
      windows: await windowsOf(fixture.accountId),
    }).toEqual({
      input: { userId: fixture.userId, source: 'statement', credentialId: null, walletId: null },
      windows: [
        {
          inputId: input.id,
          fromAt: new Date('2026-08-01T10:00:00Z'),
          toAt: CLOSE_AT,
          complete: false,
          fetchedAt: document!.createdAt,
          uploadRef: job.r2Key,
        },
      ],
    });
    await expectLabelsSettled(fixture.userId);

    expect(result).toEqual({
      format: 'csv',
      accountId: fixture.accountId,
      transactionCount: 8,
      observationCount: 1,
      holdingsCreated: [made.id],
      holdingsTouched: [
        {
          holdingId: manual.id,
          tokenId: closed.id,
          symbol: closed.symbol,
          name: closed.name,
          transactionCount: 6,
          closingBalance: '855',
          balanceFrom: 'statement-close',
          rowsBalance: null,
        },
        {
          holdingId: made.id,
          tokenId: unclosed.id,
          symbol: unclosed.symbol,
          name: unclosed.name,
          transactionCount: 2,
          closingBalance: null,
          balanceFrom: 'imported-rows',
          rowsBalance: '30',
        },
      ],
      warnings: [
        unknownWarning(unknown),
        unknownWarning(unknown),
        `1 transaction row(s) across 1 dedup key(s) shared (holding, source, externalId) with another row in the same batch and were merged into one. Keys: ${manual.id}/natural:dup-1 Check the statement for genuinely repeated entries.`,
      ],
    });
    expect(statuses).toEqual([
      'Reading uploaded file…',
      'Parsing CSV statement…',
      'Resolving 3 currencies…',
      'Ingesting 9 transactions…',
      'Saving transactions to your account…',
    ]);

    expect(disposalMarks.mock.calls).toEqual([[fixture.userId]]);
    expect(marked).toEqual([[fixture.userId, jobId]]);
    // How far back it reaches is pinned on statements dated from today, below.
    expect(
      enqueued.map(({ requestId: _requestId, lookbackDays: _lookbackDays, ...job }) => job)
    ).toEqual([{ userId: fixture.userId, tokenIds: [closed.id, unclosed.id] }]);
    expect((await documentsOf(fixture.userId)).map((d) => d.purpose)).toEqual(['file-import']);
  });

  // What every chart and rollup reads for these two holdings. The figures were
  // recorded on the import as it stood before it moved onto `FeedIngestService`.
  test('history reads the same figures at every instant around the statement', async () => {
    const { fixture, manual, csv } = await twoCurrencies();

    await run(upload(fixture, csv));

    const [, made] = await holdingsOf(fixture.accountId);
    const instants = [
      new Date('2026-07-01T00:00:00Z'),
      new Date('2026-07-20T00:00:00Z'),
      new Date('2026-08-03T12:30:00Z'),
      new Date('2026-08-06T12:00:00Z'),
      CLOSE_AT,
      new Date('2026-09-01T00:00:00Z'),
      new Date(),
    ];
    const balancesOf = async (holdingId: string) =>
      (await captureHistory([holdingId], instants)).map((reading) => reading.balance);

    expect({
      closed: await balancesOf(manual.id),
      unclosed: await balancesOf(made!.id),
    }).toEqual({
      closed: [
        '700',
        '543.956043956043956043956044',
        '969.2783882783882783882783883',
        '866.3021978021978021978021978',
        '855',
        '855',
        '855',
      ],
      unclosed: ['0', '0', '0', '30', '30', '30', '30'],
    });
  });

  // Where the balance copy shows in history: it holds the balance at the
  // import, so a value typed in later is spread back to the import and no
  // further. These figures were recorded before the move as well.
  test('history after a later balance reads the same figures: the copy still holds the import', async () => {
    const { fixture, manual, csv } = await twoCurrencies();
    await run(upload(fixture, csv));
    // The import was on 10 September, and the balance was typed over ten days later.
    const importedAt = new Date('2026-09-10T00:00:00Z');
    const typedAt = new Date('2026-09-20T00:00:00Z');
    const copies = await copiesOf(fixture.userId);
    await getDb()
      .update(observations)
      .set({ observedAt: importedAt })
      .where(
        inArray(
          observations.id,
          copies.map((c) => c.id)
        )
      );
    await getDb()
      .insert(observations)
      .values({
        userId: fixture.userId,
        holdingId: manual.id,
        balance: '900',
        observedAt: typedAt,
        source: 'sync-capture',
        sourceMetadata: { origin: 'updateHoldingBalance' },
      });
    await getDb()
      .update(holdings)
      .set({ balance: '900', lastUpdated: typedAt })
      .where(eq(holdings.id, manual.id));

    const readings = await captureHistory(
      [manual.id],
      [
        new Date('2026-08-20T00:00:00Z'),
        new Date('2026-09-05T00:00:00Z'),
        new Date('2026-09-15T00:00:00Z'),
        new Date('2026-09-25T00:00:00Z'),
      ]
    );
    expect(readings.map((reading) => reading.balance)).toEqual(['855', '855', '877.5', '900']);
  });

  test('the three early gates (column mapping, date order, currency) write nothing', async () => {
    const fixture = await seed('A');
    const gates = {
      needsColumnMapping: 'Foo,Bar\n1,2\n',
      needsDateOrder: `Date,Description,Amount,Currency\n03/04/2026,Coffee,-3.50,${fixture.tokens[0].symbol}\n05/06/2026,Tea,-2.00,${fixture.tokens[0].symbol}\n`,
      needsCurrency: 'Date,Description,Amount\n2026-08-01,Coffee,-3.50\n2026-08-02,Tea,-2.00\n',
    } as const;

    for (const [gate, csv] of Object.entries(gates)) {
      const { result } = await run(upload(fixture, csv));

      expect({
        gate,
        asked: Object.keys(result).filter((key) => key.startsWith('needs')),
        transactionCount: result.transactionCount,
        observationCount: result.observationCount,
        holdingsCreated: result.holdingsCreated,
        holdingsTouched: result.holdingsTouched,
      }).toEqual({
        gate,
        asked: [gate],
        transactionCount: 0,
        observationCount: 0,
        holdingsCreated: [],
        holdingsTouched: [],
      });
    }

    expect({
      holdings: await holdingsOf(fixture.accountId),
      ledger: await ledgerOf(fixture.userId),
      observations: await observationsOf(fixture.userId),
      inputs: await inputsOf(fixture.accountId),
      enqueued,
      marked,
      disposalMarks: disposalMarks.mock.calls,
    }).toEqual({
      holdings: [],
      ledger: [],
      observations: [],
      inputs: [],
      enqueued: [],
      marked: [],
      disposalMarks: [],
    });
  });

  test('re-uploading the same file writes no new entry, checkpoint or window, and repeats the balance write and the copy of the holding with the close', async () => {
    const { fixture, manual, csv } = await twoCurrencies();
    await run(upload(fixture, csv));
    const [, made] = await holdingsOf(fixture.accountId);
    const before = {
      ledger: (await ledgerOf(fixture.userId)).map((r) => ({ id: r.id, updatedAt: r.updatedAt })),
      holdings: (await holdingsOf(fixture.accountId)).map((h) => ({
        id: h.id,
        balance: h.balance,
      })),
      closes: (await observationsOf(fixture.userId))
        .filter((o) => o.source === 'statement-close')
        .map((o) => o.id),
      inputs: (await inputsOf(fixture.accountId)).map((i) => i.id),
      windows: await windowsOf(fixture.accountId),
    };
    expect(before.windows).toHaveLength(1);
    const copiesBefore = await copiesOf(fixture.userId);

    const { result } = await run(upload(fixture, csv));

    expect({
      ledger: (await ledgerOf(fixture.userId)).map((r) => ({ id: r.id, updatedAt: r.updatedAt })),
      holdings: (await holdingsOf(fixture.accountId)).map((h) => ({
        id: h.id,
        balance: h.balance,
      })),
      closes: (await observationsOf(fixture.userId))
        .filter((o) => o.source === 'statement-close')
        .map((o) => o.id),
      inputs: (await inputsOf(fixture.accountId)).map((i) => i.id),
      windows: await windowsOf(fixture.accountId),
    }).toEqual(before);

    // The holding the first upload created is found on the second, so it takes
    // no balance write and no copy; the one with the close takes both again.
    const copiesAfter = await copiesOf(fixture.userId);
    expect(
      copiesAfter
        .filter((c) => !copiesBefore.some((b) => b.id === c.id))
        .map((c) => [c.holdingId, c.balance])
    ).toEqual([[manual.id, '855']]);
    expect({
      transactionCount: result.transactionCount,
      observationCount: result.observationCount,
      holdingsCreated: result.holdingsCreated,
      balanceFrom: result.holdingsTouched.map((h) => [h.holdingId, h.balanceFrom, h.rowsBalance]),
    }).toEqual({
      transactionCount: 8,
      observationCount: 1,
      holdingsCreated: [],
      balanceFrom: [
        [manual.id, 'statement-close', null],
        [made!.id, 'unchanged', null],
      ],
    });
    // Each upload asks for a rebuild, the one that changed nothing included.
    expect(enqueued).toHaveLength(2);
    // One file, uploaded twice, is one document.
    expect(await documentsOf(fixture.userId)).toHaveLength(1);
    await expectLabelsSettled(fixture.userId);
  });

  test("the copy carries legacyAnchor 'file-import' and A1 reads it O2 even more than 120 s after the statement", async () => {
    const { fixture, manual, csv } = await twoCurrencies();
    await run(upload(fixture, csv));
    // The first upload was an hour ago: nothing it wrote is within 120 s of the next.
    await getDb()
      .update(ledger)
      .set({ createdAt: sql`${ledger.createdAt} - interval '1 hour'` })
      .where(eq(ledger.userId, fixture.userId));
    await getDb()
      .update(observations)
      .set({ createdAt: sql`${observations.createdAt} - interval '1 hour'` })
      .where(eq(observations.userId, fixture.userId));
    const copiesBefore = await copiesOf(fixture.userId);

    await run(upload(fixture, csv));

    const late = (await copiesOf(fixture.userId)).filter(
      (c) => !copiesBefore.some((b) => b.id === c.id)
    );
    expect(
      late.map((c) => ({
        holdingId: c.holdingId,
        sourceMetadata: c.sourceMetadata,
        role: c.role,
        authority: c.authority,
        inputId: c.inputId,
      }))
    ).toEqual([
      {
        holdingId: manual.id,
        sourceMetadata: { origin: 'updateHoldingBalance', legacyAnchor: 'file-import' },
        role: null,
        authority: null,
        inputId: null,
      },
    ]);
    await expectLabelsSettled(fixture.userId);

    // The control: without its marker the same row is a value a person typed,
    // and classification would label it.
    await getDb()
      .update(observations)
      .set({ sourceMetadata: { origin: 'updateHoldingBalance' } })
      .where(eq(observations.id, late[0]!.id));
    const unmarked = await Container.get(FoundationClassificationService).classify({
      apply: false,
      userId: fixture.userId,
    });
    expect(unmarked.rowsUpdated.observations).toBe(1);
  });

  test('one window per upload, with upload_ref: the same file twice is one window, and another file over the same dates is a second', async () => {
    const fixture = await seed('A');
    const [token] = fixture.tokens;
    const lines: Line[] = [
      {
        at: '2026-08-01T10:00:00Z',
        description: 'Salary',
        amount: '100.00',
        currency: token.symbol,
        balance: '100.00',
      },
      {
        at: '2026-08-05T10:00:00Z',
        description: 'Coffee',
        amount: '-3.50',
        currency: token.symbol,
        balance: '96.50',
      },
    ];
    const period = {
      fromAt: new Date('2026-08-01T10:00:00Z'),
      toAt: new Date('2026-08-05T10:00:00Z'),
      complete: false,
    };

    const first = upload(fixture, csvOf(lines));
    await run(first);
    // The same bytes under another key: the same document, so the same fetch.
    await run(upload(fixture, csvOf(lines)));

    const [input] = await inputsOf(fixture.accountId);
    const [document] = await documentsOf(fixture.userId);
    const firstWindow = {
      ...period,
      inputId: input!.id,
      fetchedAt: document!.createdAt,
      uploadRef: first.r2Key,
    };
    expect(await windowsOf(fixture.accountId)).toEqual([firstWindow]);

    const other = upload(
      fixture,
      csvOf(lines.map((line) => ({ ...line, description: `${line.description} again` })))
    );
    await run(other);

    const [, otherDocument] = await documentsOf(fixture.userId);
    expect(await windowsOf(fixture.accountId)).toEqual([
      firstWindow,
      {
        ...period,
        inputId: input!.id,
        fetchedAt: otherDocument!.createdAt,
        uploadRef: other.r2Key,
      },
    ]);
    expect(await inputsOf(fixture.accountId)).toHaveLength(1);
  });

  test('the backfill lookback is max(400 days, days since the oldest changed row)', async () => {
    const statementFrom = (oldest: number, currency: string) =>
      csvOf([
        { at: daysAgo(oldest), description: 'Old', amount: '10.00', currency },
        { at: daysAgo(1.5), description: 'New', amount: '5.00', currency },
      ]);
    const recent = await seed('A');
    const old = await seed('B');
    const oldStatement = statementFrom(500.5, old.tokens[0].symbol);

    await run(upload(recent, statementFrom(30.5, recent.tokens[0].symbol)));
    await run(upload(old, oldStatement));
    // The same file again changes no row.
    await run(upload(old, oldStatement));

    // A month-old statement stays at 400. The old one reaches 501 whole days
    // back to its oldest row, and the rebuild's seven of margin. Its second
    // upload wrote nothing older than 400 days, so it reaches no further.
    expect(enqueued.map((queued) => queued.lookbackDays)).toEqual([400, 508, 400]);
  });

  // The summary reads the tokens with the write. Read after the commit, a
  // failure failed a job whose import had landed, and the retry found nothing
  // changed: it named no new holding and rebuilt 400 days over older rows.
  test('a summary that cannot be read fails the import whole, so the retry is the first import', async () => {
    const fixture = await seed('A');
    const [token] = fixture.tokens;
    const job = upload(
      fixture,
      csvOf([
        { at: daysAgo(500.5), description: 'Old', amount: '10.00', currency: token.symbol },
        { at: daysAgo(1.5), description: 'New', amount: '5.00', currency: token.symbol },
      ])
    );
    const tokenRead = spyOn(Container.get(TokenRepository), 'findByIds').mockRejectedValue(
      new Error('the token read failed')
    );

    try {
      await expect(run(job)).rejects.toThrow('the token read failed');
    } finally {
      tokenRead.mockRestore();
    }

    expect({
      holdings: await holdingsOf(fixture.accountId),
      ledger: await ledgerOf(fixture.userId),
      observations: await observationsOf(fixture.userId),
      inputs: await inputsOf(fixture.accountId),
      enqueued,
    }).toEqual({ holdings: [], ledger: [], observations: [], inputs: [], enqueued: [] });

    const { result } = await run(job);

    const [made] = await holdingsOf(fixture.accountId);
    if (!made) throw new Error('the retry created no holding');
    expect({
      holdingsCreated: result.holdingsCreated,
      balanceFrom: result.holdingsTouched.map((h) => [h.balanceFrom, h.rowsBalance]),
      lookbackDays: enqueued.map((queued) => queued.lookbackDays),
    }).toEqual({
      holdingsCreated: [made.id],
      balanceFrom: [['imported-rows', '15']],
      lookbackDays: [508],
    });
  });

  // The window is what the file covered, not what could be imported (ruling R25).
  test('a row that is not imported still bounds the window: one in an unknown currency, one with no currency', async () => {
    const fixture = await seed('A');
    const [token] = fixture.tokens;
    const unknown = symbol('Z');
    const csv = csvOf([
      { at: '2026-08-01T10:00:00Z', description: 'Unknown', amount: '-5.00', currency: unknown },
      {
        at: '2026-08-03T10:00:00Z',
        description: 'Known',
        amount: '40.00',
        currency: token.symbol,
      },
      { at: '2026-08-06T10:00:00Z', description: 'Unnamed', amount: '25.00', currency: '' },
    ]);

    const { result } = await run(upload(fixture, csv));

    expect({
      rows: (await ledgerOf(fixture.userId)).map((r) => r.quantity),
      windows: (await windowsOf(fixture.accountId)).map((w) => [w.fromAt, w.toAt]),
      warnings: result.warnings,
    }).toEqual({
      rows: ['40'],
      windows: [[new Date('2026-08-01T10:00:00Z'), new Date('2026-08-06T10:00:00Z')]],
      warnings: [
        unknownWarning(unknown),
        'Transaction without currency at 2026-08-06T10:00:00.000Z — skipped (consider setting defaultCurrency on the account)',
      ],
    });
  });

  // A bank prints its local time and the parser reads it as UTC, so east of UTC
  // the last row of a fresh export sits after the moment it is imported.
  test('a statement whose last row is dated after the import still imports in full', async () => {
    const fixture = await seed('A');
    const [token] = fixture.tokens;
    const earlier = new Date(Date.now() - DAY_MS);
    const later = new Date(Date.now() + 2 * 3_600_000);
    later.setUTCMilliseconds(0);
    const csv = csvOf([
      {
        at: earlier.toISOString(),
        description: 'Salary',
        amount: '100.00',
        currency: token.symbol,
        balance: '100.00',
      },
      {
        at: later.toISOString(),
        description: 'Coffee',
        amount: '-3.50',
        currency: token.symbol,
        balance: '96.50',
      },
    ]);

    const { result } = await run(upload(fixture, csv));

    const [made] = await holdingsOf(fixture.accountId);
    expect({
      balance: made?.balance,
      rows: (await ledgerOf(fixture.userId)).map((r) => r.quantity),
      observations: (await observationsOf(fixture.userId)).map((o) => ({
        source: o.source,
        balance: o.balance,
        atTheLastRow: o.observedAt.getTime() === later.getTime(),
      })),
      transactionCount: result.transactionCount,
      observationCount: result.observationCount,
      balanceFrom: result.holdingsTouched.map((h) => h.balanceFrom),
    }).toEqual({
      balance: '96.5',
      rows: ['100', '-3.5'],
      observations: [
        { source: 'statement-close', balance: '96.5', atTheLastRow: true },
        { source: 'sync-capture', balance: '96.5', atTheLastRow: false },
      ],
      transactionCount: 2,
      observationCount: 1,
      balanceFrom: ['statement-close'],
    });
  });

  test('a statement in which every currency is unknown writes nothing and warns for each row', async () => {
    const fixture = await seed();
    const unknown = symbol('Z');
    const csv = csvOf([
      { at: '2026-08-01T10:00:00Z', description: 'One', amount: '5.00', currency: unknown },
      {
        at: '2026-08-02T10:00:00Z',
        description: 'Two',
        amount: '-2.00',
        currency: unknown,
        balance: '3.00',
      },
    ]);

    const { result, jobId } = await run(upload(fixture, csv));

    expect(result).toEqual({
      format: 'csv',
      accountId: fixture.accountId,
      transactionCount: 0,
      observationCount: 0,
      holdingsCreated: [],
      holdingsTouched: [],
      // One for each row, and one more for the close the last row carries.
      warnings: [unknownWarning(unknown), unknownWarning(unknown), unknownWarning(unknown)],
    });
    expect({
      holdings: await holdingsOf(fixture.accountId),
      ledger: await ledgerOf(fixture.userId),
      observations: await observationsOf(fixture.userId),
      // No window either: one would claim a period nothing was read for.
      inputs: await inputsOf(fixture.accountId),
      enqueued,
      marked,
    }).toEqual({
      holdings: [],
      ledger: [],
      observations: [],
      inputs: [],
      enqueued: [],
      marked: [[fixture.userId, jobId]],
    });
  });

  // Before the import moved, the holdings were built with the detected currency
  // first and the rows routed with the picked one first, so these rows found no
  // holding and were skipped as unknown. One order is left (ruling R24).
  test('a picked currency beside a detected one: the rows with no currency of their own are imported under the picked one', async () => {
    const fixture = await seed('D', 'F');
    const [detected, picked] = fixture.tokens;
    const csv = csvOf([
      {
        at: '2026-08-01T10:00:00Z',
        description: 'Named',
        amount: '40.00',
        currency: detected.symbol,
      },
      {
        at: '2026-08-02T10:00:00Z',
        description: 'Unnamed',
        amount: '25.00',
        currency: '',
        balance: '25.00',
      },
    ]);

    const { result } = await run(upload(fixture, csv, { defaultCurrency: picked.symbol }));

    expect({
      holdings: Object.fromEntries(
        (await holdingsOf(fixture.accountId)).map((h) => [h.tokenId, h.balance])
      ),
      rows: (await ledgerOf(fixture.userId)).map((r) => [r.tokenId, r.quantity]),
      transactionCount: result.transactionCount,
      observationCount: result.observationCount,
      warnings: result.warnings,
    }).toEqual({
      holdings: { [detected.id]: '40', [picked.id]: '25' },
      rows: [
        [detected.id, '40'],
        [picked.id, '25'],
      ],
      transactionCount: 2,
      observationCount: 1,
      warnings: [],
    });
  });
});

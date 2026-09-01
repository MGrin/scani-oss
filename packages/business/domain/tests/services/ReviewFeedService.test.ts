import { describe, expect, test } from 'bun:test';
import { reviewBadgeCount, reviewItemSchema } from '@scani/shared';
import Container from 'typedi';
import { DocumentExtractionRepository } from '../../src/repositories/DocumentExtractionRepository';
import { UserJobRepository } from '../../src/repositories/UserJobRepository';
import { BalanceGapService } from '../../src/services/holdings/BalanceGapService';
import { ReviewFeedService } from '../../src/services/ReviewFeedService';
import { TransferReviewService } from '../../src/services/TransferReviewService';
import { restoreContainerAfterAll } from '../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

function makeService(
  jobs: unknown[],
  extractions: unknown[] = [],
  transfers: { count: number; latestCreatedAt: Date | null } = { count: 0, latestCreatedAt: null },
  deadJobs: unknown[] = [],
  balanceGaps: { count: number; latestAt: Date | null } = { count: 0, latestAt: null }
): ReviewFeedService {
  Container.set(UserJobRepository, {
    findPendingReview: async () => jobs,
    // The dead-job collector (SC-153) queries this too; these suites are
    // about the review half, so it answers empty.
    findDeadUnacknowledged: async () => deadJobs,
  } as unknown as UserJobRepository);
  Container.set(DocumentExtractionRepository, {
    findPendingByUser: async () => extractions,
  } as unknown as DocumentExtractionRepository);
  Container.set(TransferReviewService, {
    pendingSummary: async () => transfers,
  } as unknown as TransferReviewService);
  // The balance-gap collector (SC-501) is on the same feed. Most suites here
  // are about the other producers, so it defaults to empty — stubbed rather
  // than left to resolve, because a class-field dep that reaches a real
  // repository here fails against the database instead of failing as a
  // missing stub.
  Container.set(BalanceGapService, {
    pendingSummary: async () => balanceGaps,
  } as unknown as BalanceGapService);
  const instance = new ReviewFeedService();
  Container.set(ReviewFeedService, instance);
  return instance;
}

const job = (over: Record<string, unknown> = {}) => ({
  jobId: 'a1',
  jobName: 'screenshot-parse',
  createdAt: new Date('2026-08-10T10:00:00Z'),
  result: null,
  ...over,
});

const extraction = (over: Record<string, unknown> = {}) => ({
  id: 'ext-1',
  documentId: 'doc-1',
  ordinal: 0,
  vendorNameRaw: 'Acme Utilities',
  invoiceNumber: 'INV-1',
  issueDate: '2026-08-01',
  dueDate: '2026-08-15',
  totalAmount: '42.50',
  currencyCode: 'USD',
  lineItems: [],
  confidence: '0.9',
  promptVersion: 'v1',
  extractorKind: 'text-llm',
  reviewState: 'pending',
  createdAt: new Date('2026-08-10T10:00:00Z'),
  ...over,
});

describe('ReviewFeedService.listPending', () => {
  test('maps a pending job to an actionable review item', async () => {
    const svc = makeService([job()]);
    const items = await svc.listPending('user-1');

    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('job:a1');
    expect(items[0]?.kind).toBe('screenshot-parse');
    // The job's NAME, not its English title: nothing on this side spells
    // "Document parse" any more (SC-371).
    expect(items[0]?.label).toEqual({ code: 'job', jobName: 'screenshot-parse' });
    expect(items[0]?.href).toBe('/jobs/a1');
  });

  test('returns newest first', async () => {
    const svc = makeService([
      job({ jobId: 'old', createdAt: new Date('2026-08-01T00:00:00Z') }),
      job({ jobId: 'new', createdAt: new Date('2026-08-09T00:00:00Z') }),
    ]);
    const items = await svc.listPending('user-1');
    expect(items.map((i) => i.id)).toEqual(['job:new', 'job:old']);
  });

  test('returns an empty feed when nothing is pending', async () => {
    const svc = makeService([]);
    expect(await svc.listPending('user-1')).toEqual([]);
  });

  test('every item validates against the shared contract', async () => {
    const svc = makeService([job(), job({ jobId: 'b2', jobName: 'file-import' })]);
    for (const item of await svc.listPending('user-1')) {
      expect(() => reviewItemSchema.parse(item)).not.toThrow();
    }
  });

  // The whole point of the seam: a job and an extraction are two different
  // producers concatenated by `listPending`, sorted purely by `createdAt` —
  // neither collector gets priority over the other.
  test('a pending job and a pending extraction both appear, newest first', async () => {
    const svc = makeService(
      [job({ jobId: 'older-job', createdAt: new Date('2026-08-01T00:00:00Z') })],
      [extraction({ id: 'newer-extraction', createdAt: new Date('2026-08-09T00:00:00Z') })]
    );
    const items = await svc.listPending('user-1');

    expect(items).toHaveLength(2);
    expect(items.map((i) => i.id)).toEqual(['extraction:newer-extraction', 'job:older-job']);

    const extractionItem = items.find((i) => i.id === 'extraction:newer-extraction');
    expect(extractionItem?.kind).toBe('document-extraction');
    expect(extractionItem?.href).toBe('/documents/doc-1');
    expect(extractionItem?.label).toEqual({ code: 'invoiceExtracted' });
    expect(extractionItem?.detail).toEqual({ code: 'vendor', name: 'Acme Utilities' });
    // The digits the extractor recorded, not a float's rendering of them: a
    // trailing zero survives the wire because the value never becomes a
    // number on the way (SC-371).
    expect(extractionItem?.amount).toEqual({ value: '42.50', currency: 'USD' });
    expect(() => reviewItemSchema.parse(extractionItem)).not.toThrow();
  });

  /**
   * SC-150. The transfer queue is the one collector that aggregates: it emits
   * ONE row carrying a count, where the others emit one row per record.
   *
   * A heavy-CEX user can have hundreds of unpaired outflows, every one of them
   * pointing at the same screen. Enumerating them here would bury the three
   * imports that each point somewhere different, and turn the badge from
   * "things to do" into a number nobody reads.
   */
  test('the transfer queue arrives as one row for the whole queue', async () => {
    const svc = makeService([], [], {
      count: 12,
      latestCreatedAt: new Date('2026-08-12T00:00:00Z'),
    });
    const items = await svc.listPending('user-1');

    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('transfer-review:pending');
    expect(items[0]?.kind).toBe('transfer-review');
    expect(items[0]?.label).toEqual({ code: 'transfersToConfirm' });
    expect(items[0]?.detail).toEqual({ code: 'unpairedTransfers', transfers: 12 });
    expect(items[0]?.href).toBe('/review/transfers');
    expect(() => reviewItemSchema.parse(items[0])).not.toThrow();
  });

  /**
   * The count travels as a number, so "1 transfer" versus "12 transfers" is a
   * decision the reader's own language makes — English's rule is no longer
   * hard-coded on a server that has no `t()` (SC-371). The sentence itself is
   * asserted in `tests/v3/lib/review-text.test.ts`.
   */
  test('one waiting transfer arrives as a count of one, not as a phrase', async () => {
    const svc = makeService([], [], { count: 1, latestCreatedAt: new Date() });
    const [item] = await svc.listPending('user-1');
    expect(item?.detail).toEqual({ code: 'unpairedTransfers', transfers: 1 });
  });

  /** An empty queue contributes nothing — not a row reading zero, which is a
   *  chore that cannot be completed. */
  test('an empty transfer queue adds no row', async () => {
    const svc = makeService([], [], { count: 0, latestCreatedAt: null });
    expect(await svc.listPending('user-1')).toEqual([]);
  });

  /**
   * SC-860. The two halves in one test on purpose: they are the whole point,
   * and a change that collapses them back together has to fail here.
   *
   * The FEED still shows one row per unbounded queue — that is the decision
   * the collector comments above defend, and it is not being reversed. The
   * BADGE is a different question, "how much is waiting on me", and until
   * `represents` existed it inherited the feed's row count, so 200 unpaired
   * transfers plus 30 unexplained balance changes read as **2**.
   *
   * `reviewBadgeCount` is the badge's own rule, imported here rather than
   * re-implemented as `reduce`, so this asserts what `useReviewFeed` actually
   * computes rather than a copy of it that can drift.
   */
  test('two aggregated queues stay two rows and weigh their full size', async () => {
    const svc = makeService(
      [],
      [],
      { count: 200, latestCreatedAt: new Date('2026-08-12T00:00:00Z') },
      [],
      { count: 30, latestAt: new Date('2026-08-11T00:00:00Z') }
    );
    const items = await svc.listPending('user-1');

    expect(items).toHaveLength(2);
    expect(reviewBadgeCount(items)).toBe(230);

    const transfers = items.find((i) => i.id === 'transfer-review:pending');
    const gaps = items.find((i) => i.id === 'balance-gap:pending');
    expect(transfers?.represents).toBe(200);
    expect(gaps?.represents).toBe(30);
    // The count the row already carried for its sentence and the weight the
    // badge sums are the same fact, and they may not drift apart.
    expect(transfers?.detail).toEqual({ code: 'unpairedTransfers', transfers: 200 });
    expect(gaps?.detail).toEqual({ code: 'unexplainedBalanceChanges', changes: 30 });
  });

  /**
   * The other side of the same rule: a collector that emits a row per record
   * weighs one each, so for those the badge and the row count agree — which
   * is what makes the aggregate rows' disagreement meaningful rather than an
   * arbitrary second number.
   */
  test('per-record rows weigh one each, so the badge equals the row count', async () => {
    const svc = makeService([job({ jobId: 'a1' }), job({ jobId: 'a2' }), job({ jobId: 'a3' })]);
    const items = await svc.listPending('user-1');

    expect(items).toHaveLength(3);
    expect(reviewBadgeCount(items)).toBe(3);
    expect(items.every((i) => i.represents === 1)).toBe(true);
  });

  /**
   * A count is not money, and now it cannot be mistaken for money.
   *
   * The row's figure used to be recovered by running a regex for a trailing
   * `<number> <ISO CODE>` over the English second line, so `2 files` was one
   * rephrasing away from being printed as two of a currency called FILES.
   * The value column reads `amount` and nothing else; a transfer row has none.
   */
  test('the count never reaches the value column', async () => {
    const svc = makeService([], [], { count: 12, latestCreatedAt: new Date() });
    const [item] = await svc.listPending('user-1');
    expect(item?.amount).toBeUndefined();
  });
});

import { describe, expect, test } from 'bun:test';
import { reviewItemSchema } from '@scani/shared';
import Container from 'typedi';
import { DocumentExtractionRepository } from '../../src/repositories/DocumentExtractionRepository';
import { UserJobRepository } from '../../src/repositories/UserJobRepository';
import { ReviewFeedService } from '../../src/services/ReviewFeedService';
import { TransferReviewService } from '../../src/services/TransferReviewService';

function makeService(
  jobs: unknown[],
  extractions: unknown[] = [],
  transfers: { count: number; latestCreatedAt: Date | null } = { count: 0, latestCreatedAt: null },
  deadJobs: unknown[] = []
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
    expect(items[0].id).toBe('job:a1');
    expect(items[0].kind).toBe('screenshot-parse');
    expect(items[0].href).toBe('/jobs/a1');
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
    expect(extractionItem?.subtitle).toBe('Acme Utilities — 42.50 USD');
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
    expect(items[0]?.subtitle).toBe('12 transfers out with no matching deposit');
    expect(items[0]?.href).toBe('/review/transfers');
    expect(() => reviewItemSchema.parse(items[0])).not.toThrow();
  });

  test('one waiting transfer is not described as "1 transfers"', async () => {
    const svc = makeService([], [], { count: 1, latestCreatedAt: new Date() });
    const [item] = await svc.listPending('user-1');
    expect(item?.subtitle).toBe('1 transfer out with no matching deposit');
  });

  /** An empty queue contributes nothing — not a row reading zero, which is a
   *  chore that cannot be completed. */
  test('an empty transfer queue adds no row', async () => {
    const svc = makeService([], [], { count: 0, latestCreatedAt: null });
    expect(await svc.listPending('user-1')).toEqual([]);
  });

  /**
   * `subtitle` must not parse as money. `splitReviewSubtitle` pulls a trailing
   * `<number> <ISO CODE>` into the row's value column, and a count that
   * rendered there as a currency would put "12" under the same heading as
   * "€87.31" on the same list.
   */
  test('the count does not read as an amount to the feed row renderer', async () => {
    const svc = makeService([], [], { count: 12, latestCreatedAt: new Date() });
    const [item] = await svc.listPending('user-1');
    expect(item?.subtitle).not.toMatch(/\d+\s+[A-Z]{3}$/);
  });
});

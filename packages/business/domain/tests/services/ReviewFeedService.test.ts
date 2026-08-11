import { describe, expect, test } from 'bun:test';
import { reviewItemSchema } from '@scani/shared';
import Container from 'typedi';
import { DocumentExtractionRepository } from '../../src/repositories/DocumentExtractionRepository';
import { UserJobRepository } from '../../src/repositories/UserJobRepository';
import { ReviewFeedService } from '../../src/services/ReviewFeedService';

function makeService(jobs: unknown[], extractions: unknown[] = []): ReviewFeedService {
  Container.set(UserJobRepository, {
    findPendingReview: async () => jobs,
  } as unknown as UserJobRepository);
  Container.set(DocumentExtractionRepository, {
    findPendingByUser: async () => extractions,
  } as unknown as DocumentExtractionRepository);
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
});

import { describe, expect, it } from 'bun:test';
import { ScreenshotTransactionIngester } from '../src/ScreenshotTransactionIngester';

describe('ScreenshotTransactionIngester', () => {
  it('exposes a stable source tag', () => {
    const ingester = new ScreenshotTransactionIngester(async () => ({
      holdings: [],
      overallConfidence: 0,
    }));
    expect(ingester.source).toBe('screenshot');
  });

  it('returns the empty-result shape (parser wiring is held; AI prompt pending)', async () => {
    const ingester = new ScreenshotTransactionIngester(async () => ({
      holdings: [{ symbol: 'USD', confidence: 0.9 }],
      overallConfidence: 0.9,
    }));
    const result = await ingester.ingest({
      userId: 'u1',
      accountId: 'a1',
      imageBase64: 'aW1n',
      mimeType: 'image/png',
      resolveFiatTokenBySymbol: async () => ({ tokenId: 't' }),
    });
    expect(result.transactions).toEqual([]);
    expect(result.observations).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.firstEventAt).toBeNull();
    expect(result.lastEventAt).toBeNull();
  });
});

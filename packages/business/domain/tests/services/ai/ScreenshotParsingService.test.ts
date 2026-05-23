process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterAll, describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { AIRouter, type ParsedPortfolio } from '../../../src/services/ai/AIRouter';
import { ScreenshotParsingService } from '../../../src/services/ai/ScreenshotParsingService';
import { TokenValidationService } from '../../../src/services/tokens/TokenValidationService';

afterAll(() => {
  Container.set(AIRouter, new AIRouter());
  Container.set(TokenValidationService, new TokenValidationService());
  Container.set(ScreenshotParsingService, new ScreenshotParsingService());
});

interface ValidateCall {
  symbol: string;
  tokenTypeCode?: string;
}

// Stubs AIRouter (returns `portfolio`) + TokenValidationService
// (records every validateToken call), then builds the service.
function setup(portfolio: ParsedPortfolio): {
  service: ScreenshotParsingService;
  calls: ValidateCall[];
} {
  const calls: ValidateCall[] = [];

  Container.set(AIRouter, {
    hasAvailableProvider: () => true,
    parseScreenshot: async () => ({ portfolio, metadata: { provider: 'ai-stub' } }),
  } as unknown as AIRouter);

  Container.set(TokenValidationService, {
    validateToken: async (symbol: string, tokenTypeCode?: string) => {
      calls.push({ symbol, tokenTypeCode });
      return { isValid: false, error: 'stub: not resolved' };
    },
  } as unknown as TokenValidationService);

  const service = new ScreenshotParsingService();
  Container.set(ScreenshotParsingService, service);
  return { service, calls };
}

describe('ScreenshotParsingService — asset-type hinting', () => {
  test('forces fiat for an ISO-4217 symbol and passes it to validateToken', async () => {
    // AI mislabelled USD as a stock; the isFiatCode backstop corrects it.
    const { service, calls } = setup({
      holdings: [{ symbol: 'USD', balance: '500', confidence: 0.9, assetType: 'stock' }],
      overallConfidence: 0.9,
    });

    const result = await service.parseScreenshot('img-base64');

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ symbol: 'USD', tokenTypeCode: 'fiat' });
    expect(result.holdings[0]?.assetType).toBe('fiat');
  });

  test('passes the AI assetType through for a non-fiat symbol', async () => {
    const { service, calls } = setup({
      holdings: [{ symbol: 'AAPL', balance: '10', confidence: 0.9, assetType: 'stock' }],
      overallConfidence: 0.9,
    });

    const result = await service.parseScreenshot('img-base64');

    expect(calls[0]).toEqual({ symbol: 'AAPL', tokenTypeCode: 'stock' });
    expect(result.holdings[0]?.assetType).toBe('stock');
  });
});

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { AIRouter, type ParsedPortfolio } from '../../../src/services/ai/AIRouter';
import { AiBudgetExceededError } from '../../../src/services/ai/AiSpendBudget';
import { ScreenshotParsingService } from '../../../src/services/ai/ScreenshotParsingService';
import { TokenValidationService } from '../../../src/services/tokens/TokenValidationService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

interface ValidateCall {
  symbol: string;
  tokenTypeCode?: string;
}

// Stubs AIRouter (returns `portfolio`) + TokenValidationService
// (records every validateToken call), then builds the service.
function setup(
  portfolio: ParsedPortfolio,
  opts: { refuse?: boolean } = {}
): {
  service: ScreenshotParsingService;
  calls: ValidateCall[];
  aiCalls: string[];
  routedFor: string[];
} {
  const calls: ValidateCall[] = [];
  const aiCalls: string[] = [];
  const routedFor: string[] = [];

  Container.set(AIRouter, {
    hasAvailableProvider: () => true,
    parseScreenshot: async (_img: string, o: { userId: string }) => {
      if (opts.refuse) throw new AiBudgetExceededError('user');
      routedFor.push(o.userId);
      aiCalls.push('screenshot');
      return { portfolio, metadata: { provider: 'ai-stub' } };
    },
    parseDocumentText: async (_text: string, o: { userId: string }) => {
      if (opts.refuse) throw new AiBudgetExceededError('user');
      routedFor.push(o.userId);
      aiCalls.push('text');
      return { portfolio, metadata: { provider: 'ai-stub' } };
    },
  } as unknown as AIRouter);

  Container.set(TokenValidationService, {
    validateToken: async (symbol: string, tokenTypeCode?: string) => {
      calls.push({ symbol, tokenTypeCode });
      return { isValid: false, error: 'stub: not resolved' };
    },
  } as unknown as TokenValidationService);

  const service = new ScreenshotParsingService();
  Container.set(ScreenshotParsingService, service);
  return { service, calls, aiCalls, routedFor };
}

describe('ScreenshotParsingService — asset-type hinting', () => {
  test('forces fiat for an ISO-4217 symbol and passes it to validateToken', async () => {
    // AI mislabelled USD as a stock; the isFiatCode backstop corrects it.
    const { service, calls } = setup({
      holdings: [{ symbol: 'USD', balance: '500', confidence: 0.9, assetType: 'stock' }],
      overallConfidence: 0.9,
    });

    const result = await service.parseScreenshot('img-base64', { userId: 'u1' });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ symbol: 'USD', tokenTypeCode: 'fiat' });
    expect(result.holdings[0]?.assetType).toBe('fiat');
  });

  test('passes the AI assetType through for a non-fiat symbol', async () => {
    const { service, calls } = setup({
      holdings: [{ symbol: 'AAPL', balance: '10', confidence: 0.9, assetType: 'stock' }],
      overallConfidence: 0.9,
    });

    const result = await service.parseScreenshot('img-base64', { userId: 'u1' });

    expect(calls[0]).toEqual({ symbol: 'AAPL', tokenTypeCode: 'stock' });
    expect(result.holdings[0]?.assetType).toBe('stock');
  });
});

describe('ScreenshotParsingService — AI budget (SC-1265)', () => {
  const portfolio: ParsedPortfolio = { holdings: [], overallConfidence: 0.9 };

  // The router charges per provider attempt; this service's part is to name
  // the user and to let the router's refusal through unwrapped.
  test("the router's refusal reaches the caller unwrapped on both paths", async () => {
    const { service, aiCalls } = setup(portfolio, { refuse: true });
    await expect(service.parseScreenshot('img', { userId: 'u1' })).rejects.toBeInstanceOf(
      AiBudgetExceededError
    );
    await expect(service.parseDocumentText('text', { userId: 'u1' })).rejects.toBeInstanceOf(
      AiBudgetExceededError
    );
    expect(aiCalls).toEqual([]);
  });

  test('each call routes under its own user, so the router charges the right budget', async () => {
    const { service, aiCalls, routedFor } = setup(portfolio);
    await service.parseScreenshot('img', { userId: 'u1' });
    await service.parseDocumentText('text', { userId: 'u2' });
    expect(routedFor).toEqual(['u1', 'u2']);
    expect(aiCalls).toEqual(['screenshot', 'text']);
  });
});

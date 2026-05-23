process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterAll, describe, expect, test } from 'bun:test';
import { ProviderRegistry } from '@scani/providers/core/registry';
import { Container } from 'typedi';
import { AIRouter } from '../../../src/services/ai/AIRouter';

afterAll(() => {
  Container.set(ProviderRegistry, new ProviderRegistry());
});

// Registers a stub AI provider that returns `aiData` verbatim from
// parseScreenshot, then builds an AIRouter over that registry.
function setupRouter(aiData: unknown): AIRouter {
  const provider = {
    providerKey: 'ai-stub',
    capabilities: ['ai-inference'] as const,
    parseScreenshot: async () => ({ data: aiData }),
  };
  const registry = new ProviderRegistry();
  registry.register(provider as never);
  Container.set(ProviderRegistry, registry);
  return new AIRouter();
}

describe('AIRouter — normalizePortfolio assetType handling', () => {
  test('keeps a valid assetType from the AI response', async () => {
    const router = setupRouter({
      holdings: [{ symbol: 'USD', balance: '100', confidence: 0.9, assetType: 'fiat' }],
      overallConfidence: 0.9,
    });
    const result = await router.parseScreenshot('img-base64');
    expect(result.portfolio.holdings).toHaveLength(1);
    expect(result.portfolio.holdings[0]?.assetType).toBe('fiat');
  });

  test('drops an unrecognised assetType', async () => {
    const router = setupRouter({
      holdings: [{ symbol: 'AAPL', balance: '5', confidence: 0.8, assetType: 'equity' }],
      overallConfidence: 0.8,
    });
    const result = await router.parseScreenshot('img-base64');
    expect(result.portfolio.holdings[0]?.assetType).toBeUndefined();
  });

  test('leaves assetType undefined when the AI omits it', async () => {
    const router = setupRouter({
      holdings: [{ symbol: 'ETH', balance: '2', confidence: 0.7 }],
      overallConfidence: 0.7,
    });
    const result = await router.parseScreenshot('img-base64');
    expect(result.portfolio.holdings[0]?.assetType).toBeUndefined();
  });
});

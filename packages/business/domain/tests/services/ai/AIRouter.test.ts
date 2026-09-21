process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import { ProviderRegistry } from '@scani/providers/core/registry';
import { Container } from 'typedi';
import { AIRouter } from '../../../src/services/ai/AIRouter';
import { AiBudgetExceededError, AiSpendBudget } from '../../../src/services/ai/AiSpendBudget';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

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
  Container.set(AiSpendBudget, { reserve: async () => {} } as unknown as AiSpendBudget);
  return new AIRouter();
}

describe('AIRouter — normalizePortfolio assetType handling', () => {
  test('keeps a valid assetType from the AI response', async () => {
    const router = setupRouter({
      holdings: [{ symbol: 'USD', balance: '100', confidence: 0.9, assetType: 'fiat' }],
      overallConfidence: 0.9,
    });
    const result = await router.parseScreenshot('img-base64', { userId: 'u1' });
    expect(result.portfolio.holdings).toHaveLength(1);
    expect(result.portfolio.holdings[0]?.assetType).toBe('fiat');
  });

  test('drops an unrecognised assetType', async () => {
    const router = setupRouter({
      holdings: [{ symbol: 'AAPL', balance: '5', confidence: 0.8, assetType: 'equity' }],
      overallConfidence: 0.8,
    });
    const result = await router.parseScreenshot('img-base64', { userId: 'u1' });
    expect(result.portfolio.holdings[0]?.assetType).toBeUndefined();
  });

  test('leaves assetType undefined when the AI omits it', async () => {
    const router = setupRouter({
      holdings: [{ symbol: 'ETH', balance: '2', confidence: 0.7 }],
      overallConfidence: 0.7,
    });
    const result = await router.parseScreenshot('img-base64', { userId: 'u1' });
    expect(result.portfolio.holdings[0]?.assetType).toBeUndefined();
  });
});

/**
 * SC-1265's follow-up. The router falls back across providers, and every
 * attempt is a billed call whether or not it succeeds, so the budget is
 * charged per ATTEMPT. Charging once per logical call let one refused-looking
 * request cost three.
 */
describe('AIRouter — the AI budget is charged per provider attempt', () => {
  function setup(refuseOnAttempt: number | null) {
    const attempts: string[] = [];
    let charged = 0;
    const failing = (key: string) => ({
      providerKey: key,
      capabilities: ['ai-inference'] as const,
      parseScreenshot: async () => {
        attempts.push(key);
        throw new Error(`${key} down`);
      },
      parseDocumentText: async () => {
        attempts.push(key);
        throw new Error(`${key} down`);
      },
      completeText: async () => {
        attempts.push(key);
        throw new Error(`${key} down`);
      },
    });
    const working = {
      providerKey: 'c',
      capabilities: ['ai-inference'] as const,
      parseScreenshot: async () => {
        attempts.push('c');
        return { data: { holdings: [], overallConfidence: 1 } };
      },
      parseDocumentText: async () => {
        attempts.push('c');
        return { data: { holdings: [], overallConfidence: 1 } };
      },
      completeText: async () => {
        attempts.push('c');
        return { data: '{}' };
      },
    };
    const registry = new ProviderRegistry();
    for (const p of [failing('a'), failing('b'), working]) registry.register(p as never);
    Container.set(ProviderRegistry, registry);
    Container.set(AiSpendBudget, {
      reserve: async (_userId: string, calls: number) => {
        charged += calls;
        // Refuses ONLY that attempt, so a refusal swallowed as a provider
        // failure would let the next attempt succeed and be caught here.
        if (charged === refuseOnAttempt) {
          throw new AiBudgetExceededError('user');
        }
      },
    } as unknown as AiSpendBudget);
    return { router: new AIRouter(), attempts, charged: () => charged };
  }

  test.each([
    ['parseScreenshot', (r: AIRouter) => r.parseScreenshot('img', { userId: 'u1' })],
    ['parseDocumentText', (r: AIRouter) => r.parseDocumentText('text', { userId: 'u1' })],
    ['completeText', (r: AIRouter) => r.completeText('prompt', { userId: 'u1' })],
  ] as const)('%s charges one unit for each of the three attempts', async (_name, call) => {
    const { router, attempts, charged } = setup(null);
    await call(router);
    expect(attempts).toEqual(['a', 'b', 'c']);
    expect(charged()).toBe(3);
  });

  test('a refusal on the second attempt stops the fallback before that provider is called', async () => {
    const { router, attempts } = setup(2);
    await expect(router.parseScreenshot('img', { userId: 'u1' })).rejects.toBeInstanceOf(
      AiBudgetExceededError
    );
    expect(attempts).toEqual(['a']);
  });
});

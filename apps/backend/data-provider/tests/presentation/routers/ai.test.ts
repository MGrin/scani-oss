import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AIInferenceProvider } from '@scani/providers/core/capabilities';
import { aiRouter } from '../../../src/presentation/routers/ai';
import {
  buildAuthedContext,
  buildUnauthedContext,
  installFreshRegistry,
} from '../../helpers/test-context';

let restoreRegistry: () => void;
let registry: ReturnType<typeof installFreshRegistry>['registry'];

beforeEach(() => {
  const x = installFreshRegistry();
  registry = x.registry;
  restoreRegistry = x.restore;
});

afterEach(() => {
  restoreRegistry();
});

const okPortfolio = {
  holdings: [
    { symbol: 'AAPL', balance: '10', confidence: 0.95 },
    { symbol: 'BTC', balance: '0.5', confidence: 0.8 },
  ],
  overallConfidence: 0.87,
  context: 'parsed from screenshot',
};

function makeAi(
  overrides: Partial<AIInferenceProvider> & { providerKey?: string } = {}
): AIInferenceProvider {
  return {
    providerKey: overrides.providerKey ?? 'openai',
    capabilities: ['ai-inference'],
    parseScreenshot: async () => okPortfolio,
    parseDocumentText: async () => okPortfolio,
    completeText: async (_prompt) => 'completion-text',
    ...overrides,
  } as AIInferenceProvider;
}

describe('aiRouter — auth', () => {
  test('rejects unauthed parseScreenshot', async () => {
    const caller = aiRouter.createCaller(buildUnauthedContext());
    await expect(
      caller.parseScreenshot({ imageBase64: 'aW1n', options: { mimeType: 'image/png' } })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('aiRouter.parseScreenshot', () => {
  test('returns parsed portfolio from the first registered AI provider', async () => {
    registry.register(makeAi());
    const caller = aiRouter.createCaller(buildAuthedContext());
    const out = await caller.parseScreenshot({
      imageBase64: 'aW1nLWRhdGE=',
      options: { mimeType: 'image/png' },
    });
    expect(out.portfolio.holdings).toHaveLength(2);
    expect(out.portfolio.overallConfidence).toBeCloseTo(0.87);
    expect(out.metadata?.provider).toBe('openai');
  });

  test('falls through to second provider when the first throws', async () => {
    registry.register(
      makeAi({
        providerKey: 'openai',
        parseScreenshot: async () => {
          throw new Error('rate limit');
        },
      })
    );
    registry.register(makeAi({ providerKey: 'perplexity' }));
    const caller = aiRouter.createCaller(buildAuthedContext());
    const out = await caller.parseScreenshot({
      imageBase64: 'aW1n',
      options: { mimeType: 'image/jpeg' },
    });
    expect(out.metadata?.provider).toBe('perplexity');
  });

  test('rejects when no AI providers are registered', async () => {
    const caller = aiRouter.createCaller(buildAuthedContext());
    await expect(
      caller.parseScreenshot({ imageBase64: 'aW1n', options: { mimeType: 'image/png' } })
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });

  test('honours forced provider selection via options.provider', async () => {
    registry.register(makeAi({ providerKey: 'openai' }));
    registry.register(makeAi({ providerKey: 'deepseek' }));
    const caller = aiRouter.createCaller(buildAuthedContext());
    const out = await caller.parseScreenshot({
      imageBase64: 'aW1n',
      options: { provider: 'deepseek', mimeType: 'image/png' },
    });
    expect(out.metadata?.provider).toBe('deepseek');
  });

  test('rejects when forced-provider key is unknown', async () => {
    registry.register(makeAi({ providerKey: 'openai' }));
    const caller = aiRouter.createCaller(buildAuthedContext());
    await expect(
      caller.parseScreenshot({
        imageBase64: 'aW1n',
        options: { provider: 'unknown', mimeType: 'image/png' },
      })
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });
});

describe('aiRouter.parseDocumentText', () => {
  test('returns parsed portfolio from text', async () => {
    registry.register(makeAi());
    const caller = aiRouter.createCaller(buildAuthedContext());
    const out = await caller.parseDocumentText({ text: 'document body here' });
    expect(out.portfolio.holdings.length).toBeGreaterThan(0);
  });

  test('skips providers without parseDocumentText support', async () => {
    registry.register(
      makeAi({
        providerKey: 'openai',
        parseDocumentText: undefined,
      })
    );
    registry.register(makeAi({ providerKey: 'perplexity' }));
    const caller = aiRouter.createCaller(buildAuthedContext());
    const out = await caller.parseDocumentText({ text: 'doc' });
    expect(out.metadata?.provider).toBe('perplexity');
  });
});

describe('aiRouter.completeText', () => {
  test('returns content + provider on success', async () => {
    registry.register(makeAi());
    const caller = aiRouter.createCaller(buildAuthedContext());
    const out = await caller.completeText({ prompt: 'hello' });
    expect(out.content).toBe('completion-text');
    expect(out.provider).toBe('openai');
  });

  test('falls through to the next provider on throw', async () => {
    registry.register(
      makeAi({
        providerKey: 'openai',
        completeText: async () => {
          throw new Error('overloaded');
        },
      })
    );
    registry.register(makeAi({ providerKey: 'deepseek' }));
    const caller = aiRouter.createCaller(buildAuthedContext());
    const out = await caller.completeText({ prompt: 'hi' });
    expect(out.provider).toBe('deepseek');
  });
});

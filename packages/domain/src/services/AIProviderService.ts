import { AIProviderManager } from '@scani/ai-providers';
import { CloudAIProviderManager } from '@scani/cloud-client/adapters/ai';
import { getCloudClient } from '@scani/cloud-client/runtime';
import { createComponentLogger } from '@scani/logging';
import { Service } from 'typedi';
import { BaseService } from './BaseService';

/**
 * Owns the singleton AI provider manager that every AI-powered feature
 * (CSV-column detection, screenshot parsing) shares.
 *
 * In cloud mode (when `SCANI_CLOUD_URL` + `SCANI_CLOUD_API_KEY` are set)
 * this routes every call through the data-provider service instead of
 * talking to OpenAI/Perplexity/DeepSeek directly. The `manager` field is
 * duck-typed as `AIProviderManager` so callers don't need to know which
 * transport is in play.
 */
type ManagerLike = AIProviderManager | CloudAIProviderManager;

@Service()
export class AIProviderService extends BaseService {
  readonly manager: ManagerLike;

  constructor() {
    super('AIProviderService');

    const cloudClient = getCloudClient();
    const aiLogger = createComponentLogger('ai-provider-service');

    if (cloudClient) {
      const cloudManager = new CloudAIProviderManager({ client: cloudClient });
      // Best-effort warm-up so synchronous getStatus() returns real data
      // for the liveness endpoint instead of an empty array on first hit.
      void cloudManager.refreshStatus();
      this.manager = cloudManager;
      aiLogger.info(
        { cloudUrl: process.env.SCANI_CLOUD_URL },
        '🤖 AI provider routed through data-provider (cloud mode)'
      );
      return;
    }

    this.manager = new AIProviderManager({
      defaultProvider:
        (process.env.AI_DEFAULT_PROVIDER as 'openai' | 'perplexity' | 'deepseek') || 'openai',
      providers: {
        openai: process.env.OPENAI_API_KEY
          ? {
              apiKey: process.env.OPENAI_API_KEY,
              model: process.env.OPENAI_VISION_MODEL || 'gpt-4o',
            }
          : undefined,
        perplexity: process.env.PERPLEXITY_API_KEY
          ? {
              apiKey: process.env.PERPLEXITY_API_KEY,
              model: process.env.PERPLEXITY_VISION_MODEL || 'llama-3.2-90b-vision-instruct',
            }
          : undefined,
        deepseek: process.env.DEEPSEEK_API_KEY
          ? {
              apiKey: process.env.DEEPSEEK_API_KEY,
              model: process.env.DEEPSEEK_VISION_MODEL || 'deepseek-vl',
            }
          : undefined,
      },
    });
  }

  getStatus(): {
    availableProviders: ReturnType<AIProviderManager['getAvailableProviders']>;
    hasAvailableProvider: boolean;
  } {
    return {
      availableProviders: this.manager.getAvailableProviders(),
      hasAvailableProvider: this.manager.hasAvailableProvider(),
    };
  }
}

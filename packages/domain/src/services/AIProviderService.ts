import { AIProviderManager } from '@scani/ai-providers';
import { Service } from 'typedi';
import { BaseService } from './BaseService';

/**
 * Owns the singleton `AIProviderManager` that every AI-powered feature
 * (CSV-column detection, screenshot parsing) shares. Extracted from the
 * old monolithic `AIService` so each AI feature is its own small
 * service, sharing only the provider-wiring concern.
 */
@Service()
export class AIProviderService extends BaseService {
  readonly manager: AIProviderManager;

  constructor() {
    super('AIProviderService');

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

import { DeepSeekProvider } from './deepseek-provider';
import { OpenAIProvider } from './openai-provider';
import { PerplexityProvider } from './perplexity-provider';
import type { AIProviderResponse } from './types';
import { type AIProvider, AIProviderError } from './types';

export type AIProviderType = 'openai' | 'perplexity' | 'deepseek';

export interface AIProviderManagerConfig {
  defaultProvider: AIProviderType;
  providers: {
    openai?: {
      apiKey: string;
      model?: string;
    };
    perplexity?: {
      apiKey: string;
      model?: string;
    };
    deepseek?: {
      apiKey: string;
      model?: string;
    };
  };
}

export class AIProviderManager {
  private providers: Map<AIProviderType, AIProvider> = new Map();
  private config: AIProviderManagerConfig;

  constructor(config: AIProviderManagerConfig) {
    this.config = config;
    this.initializeProviders();
  }

  private initializeProviders(): void {
    // Initialize OpenAI provider
    if (this.config.providers.openai?.apiKey) {
      this.providers.set(
        'openai',
        new OpenAIProvider({
          name: 'OpenAI',
          apiKey: this.config.providers.openai.apiKey,
          baseUrl: 'https://api.openai.com/v1',
          visionModel: this.config.providers.openai.model || 'gpt-4o',
        })
      );
    }

    // Initialize Perplexity provider
    if (this.config.providers.perplexity?.apiKey) {
      this.providers.set(
        'perplexity',
        new PerplexityProvider({
          name: 'Perplexity',
          apiKey: this.config.providers.perplexity.apiKey,
          baseUrl: 'https://api.perplexity.ai',
          visionModel: this.config.providers.perplexity.model || 'llama-3.2-90b-vision-instruct',
        })
      );
    }

    // Initialize DeepSeek provider
    if (this.config.providers.deepseek?.apiKey) {
      this.providers.set(
        'deepseek',
        new DeepSeekProvider({
          name: 'DeepSeek',
          apiKey: this.config.providers.deepseek.apiKey,
          baseUrl: 'https://api.deepseek.com/v1',
          visionModel: this.config.providers.deepseek.model || 'deepseek-vl',
        })
      );
    }
  }

  /**
   * Parse screenshot using specified provider or default
   */
  async parseScreenshot(
    imageBase64: string,
    options?: {
      provider?: AIProviderType;
      accountType?: string;
      expectedCurrency?: string;
      context?: string;
      fallbackProviders?: boolean;
    }
  ): Promise<AIProviderResponse> {
    const targetProvider = options?.provider || this.config.defaultProvider;
    const useFallback = options?.fallbackProviders ?? true;

    // Try primary provider
    try {
      const provider = this.getProvider(targetProvider);
      return await provider.parseScreenshot(imageBase64, {
        accountType: options?.accountType,
        expectedCurrency: options?.expectedCurrency,
        context: options?.context,
      });
    } catch (error) {
      console.error(`Primary provider ${targetProvider} failed:`, error);

      if (!useFallback) {
        throw error;
      }
    }

    // Try fallback providers
    if (useFallback) {
      const availableProviders = Array.from(this.providers.keys()).filter(
        (name) => name !== targetProvider
      );

      for (const providerName of availableProviders) {
        try {
          console.log(`Trying fallback provider: ${providerName}`);
          const provider = this.getProvider(providerName);
          const result = await provider.parseScreenshot(imageBase64, {
            accountType: options?.accountType,
            expectedCurrency: options?.expectedCurrency,
            context: options?.context,
          });

          // Add fallback info to metadata
          if (result.metadata) {
            result.metadata.fallbackUsed = true;
            result.metadata.originalProvider = targetProvider;
          }

          return result;
        } catch (fallbackError) {
          console.error(`Fallback provider ${providerName} failed:`, fallbackError);
        }
      }
    }

    throw new AIProviderError(
      'All AI providers failed to parse screenshot',
      'AIProviderManager',
      'ALL_PROVIDERS_FAILED'
    );
  }

  /**
   * Get available providers and their status
   */
  getAvailableProviders(): Array<{
    name: AIProviderType;
    configured: boolean;
    isDefault: boolean;
    info: ReturnType<AIProvider['getProviderInfo']>;
  }> {
    const result: Array<{
      name: AIProviderType;
      configured: boolean;
      isDefault: boolean;
      info: ReturnType<AIProvider['getProviderInfo']>;
    }> = [];

    for (const [name, provider] of this.providers) {
      result.push({
        name,
        configured: provider.isConfigured(),
        isDefault: name === this.config.defaultProvider,
        info: provider.getProviderInfo(),
      });
    }

    return result;
  }

  /**
   * Check if any provider is available
   */
  hasAvailableProvider(): boolean {
    return Array.from(this.providers.values()).some((provider) => provider.isConfigured());
  }

  /**
   * Get provider by name
   */
  private getProvider(name: AIProviderType): AIProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new AIProviderError(
        `Provider ${name} not configured`,
        'AIProviderManager',
        'PROVIDER_NOT_CONFIGURED'
      );
    }

    if (!provider.isConfigured()) {
      throw new AIProviderError(
        `Provider ${name} is not properly configured (missing API key)`,
        'AIProviderManager',
        'PROVIDER_MISCONFIGURED'
      );
    }

    return provider;
  }

  /**
   * Update provider configuration
   */
  updateConfig(config: Partial<AIProviderManagerConfig>): void {
    this.config = { ...this.config, ...config };
    this.providers.clear();
    this.initializeProviders();
  }
}

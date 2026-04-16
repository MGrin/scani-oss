import { createComponentLogger } from '../../utils/logger';
import { DeepSeekProvider } from './deepseek-provider';
import { OpenAIProvider } from './openai-provider';
import { PerplexityProvider } from './perplexity-provider';
import type { AIProviderConfig, AIProviderResponse } from './types';
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
  private readonly logger = createComponentLogger('ai-provider-manager');

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
      mimeType?: string;
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
        mimeType: options?.mimeType,
      });
    } catch (error) {
      this.logger.error(
        {
          provider: targetProvider,
          error: error instanceof Error ? { name: error.name, message: error.message } : error,
        },
        'Primary AI provider failed'
      );

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
          this.logger.debug({ provider: providerName }, 'Trying fallback AI provider');
          const provider = this.getProvider(providerName);
          const result = await provider.parseScreenshot(imageBase64, {
            accountType: options?.accountType,
            expectedCurrency: options?.expectedCurrency,
            context: options?.context,
            mimeType: options?.mimeType,
          });

          // Add fallback info to metadata
          if (result.metadata) {
            result.metadata.fallbackUsed = true;
            result.metadata.originalProvider = targetProvider;
          }

          return result;
        } catch (fallbackError) {
          this.logger.error(
            {
              provider: providerName,
              error:
                fallbackError instanceof Error
                  ? { name: fallbackError.name, message: fallbackError.message }
                  : fallbackError,
            },
            'Fallback AI provider failed'
          );
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
   * Make a text-only AI completion (no images). Uses the same provider
   * infrastructure with fallback. Ideal for lightweight tasks like
   * CSV column mapping where vision is not needed.
   */
  async completeText(
    prompt: string,
    options?: {
      provider?: AIProviderType;
      maxTokens?: number;
      temperature?: number;
      jsonMode?: boolean;
      fallbackProviders?: boolean;
    }
  ): Promise<{ content: string; provider: string }> {
    const targetProvider = options?.provider || this.config.defaultProvider;
    const useFallback = options?.fallbackProviders ?? true;
    const providerOrder = [
      targetProvider,
      ...(useFallback ? Array.from(this.providers.keys()).filter((n) => n !== targetProvider) : []),
    ];

    for (const providerName of providerOrder) {
      const provider = this.providers.get(providerName);
      if (!provider || !provider.isConfigured()) continue;

      try {
        const info = provider.getProviderInfo();
        // Use a cheaper model for text tasks when available
        const model =
          providerName === 'openai'
            ? 'gpt-4o-mini'
            : providerName === 'deepseek'
              ? 'deepseek-chat'
              : info.model;

        const config = (provider as unknown as { config: AIProviderConfig }).config;
        const baseUrl = config.baseUrl;

        const body: Record<string, unknown> = {
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: options?.maxTokens || 200,
          temperature: options?.temperature ?? 0,
        };
        if (options?.jsonMode && providerName === 'openai') {
          body.response_format = { type: 'json_object' };
        }

        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          this.logger.warn(
            { provider: providerName, status: response.status },
            'Text completion failed'
          );
          continue;
        }

        const data = (await response.json()) as {
          choices: Array<{ message: { content: string } }>;
        };
        const content = data.choices?.[0]?.message?.content;
        if (content) {
          return { content, provider: providerName };
        }
      } catch (error) {
        this.logger.warn(
          {
            provider: providerName,
            error: error instanceof Error ? error.message : error,
          },
          'Text completion error, trying next provider'
        );
      }
    }

    throw new AIProviderError(
      'All AI providers failed for text completion',
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

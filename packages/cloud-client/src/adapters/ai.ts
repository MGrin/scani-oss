import type {
  AIProviderManagerConfig,
  AIProviderResponse,
  AIProviderType,
} from '@scani/ai-providers';
import type { CloudClient } from '../index';
import { CloudError } from '../index';

/**
 * Duck-typed stand-in for `AIProviderManager`. Every method signature has
 * to match 1:1 with the real manager because `AIProviderService` types
 * `readonly manager: AIProviderManager`, and we want to swap instances
 * without touching call sites in `@scani/domain`.
 *
 * The real provider selection, rate limits, and fallback logic lives in
 * the data-provider — so this adapter is a thin RPC wrapper.
 */
export class CloudAIProviderManager {
  private readonly client: CloudClient;

  constructor(opts: { client: CloudClient }) {
    this.client = opts.client;
  }

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
    try {
      return (await this.client.ai.parseScreenshot.mutate({
        imageBase64,
        options,
      })) as AIProviderResponse;
    } catch (err) {
      throw CloudError.wrap(err);
    }
  }

  async parseDocumentText(
    text: string,
    options?: {
      provider?: AIProviderType;
      accountType?: string;
      expectedCurrency?: string;
      context?: string;
    }
  ): Promise<AIProviderResponse> {
    try {
      return (await this.client.ai.parseDocumentText.mutate({
        text,
        options,
      })) as AIProviderResponse;
    } catch (err) {
      throw CloudError.wrap(err);
    }
  }

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
    try {
      return await this.client.ai.completeText.mutate({ prompt, options });
    } catch (err) {
      throw CloudError.wrap(err);
    }
  }

  getAvailableProviders(): Array<{
    name: AIProviderType;
    configured: boolean;
    isDefault: boolean;
    info: { name: string; model: string; configured: boolean };
  }> {
    // `AIProviderService.getStatus()` is called synchronously in some
    // health endpoints. We cache the last async status result and return
    // it; returning an empty array the first time is acceptable because
    // the status endpoint tolerates it.
    return this.cachedStatus?.availableProviders ?? [];
  }

  hasAvailableProvider(): boolean {
    return this.cachedStatus?.hasAvailableProvider ?? true;
  }

  /**
   * Bootstraps the cache used by the two sync accessors above. Callers
   * should trigger this once at service start (or during liveness probe).
   */
  async refreshStatus(): Promise<void> {
    try {
      const s = await this.client.ai.status.query();
      this.cachedStatus = s;
    } catch {
      // Swallow: status is opportunistic diagnostics, not a hard gate.
    }
  }

  updateConfig(_config: Partial<AIProviderManagerConfig>): void {
    // No-op: the cloud data-provider manages its own config via env.
  }

  private cachedStatus: {
    availableProviders: Array<{
      name: AIProviderType;
      configured: boolean;
      isDefault: boolean;
      info: { name: string; model: string; configured: boolean };
    }>;
    hasAvailableProvider: boolean;
  } | null = null;
}

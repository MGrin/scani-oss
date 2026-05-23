/**
 * `CloudAIProvider` — `AIInferenceProvider` proxy. Backend / worker
 * never holds raw OpenAI API keys in cloud mode; every prompt routes
 * through the data-provider, which holds the system credentials and
 * applies per-tenant quota.
 *
 * Direct mode replaces this with the concrete `OpenAIProvider` from
 * `providers/ai-openai/`.
 *
 * The data-provider's tRPC routers attribute usage upstream — token
 * counts and `upstreamCostUsd` are already recorded in
 * `cloud_usage_events` on that side. This proxy therefore returns
 * `AIResult` with `usage` left undefined so domain callers don't
 * double-account.
 */

import type { AIInferenceProvider, AIResult, Capability } from '../capabilities';
import type { CloudProviderClient } from './cloud-client';

export class CloudAIProvider implements AIInferenceProvider {
  readonly capabilities: readonly Capability[] = ['ai-inference'];

  constructor(
    readonly providerKey: string,
    private readonly client: CloudProviderClient
  ) {}

  async parseScreenshot(input: {
    imageBase64: string;
    mimeType: string;
    hint?: string;
  }): Promise<AIResult<unknown>> {
    const data = await this.client.parseScreenshot({
      providerKey: this.providerKey,
      imageBase64: input.imageBase64,
      mimeType: input.mimeType,
      hint: input.hint,
    });
    return { data };
  }

  async parseDocumentText(text: string, hint?: string): Promise<AIResult<unknown>> {
    const data = await this.client.parseDocumentText({
      providerKey: this.providerKey,
      text,
      hint,
    });
    return { data };
  }

  async completeText(
    prompt: string,
    opts?: { temperature?: number; maxTokens?: number }
  ): Promise<AIResult<string>> {
    const data = await this.client.completeText({
      providerKey: this.providerKey,
      prompt,
      temperature: opts?.temperature,
      maxTokens: opts?.maxTokens,
    });
    return { data };
  }
}

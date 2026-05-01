/**
 * `CloudAIProvider` — `AIInferenceProvider` proxy. Backend / worker
 * never holds raw OpenAI API keys in cloud mode; every prompt routes
 * through the data-provider, which holds the system credentials and
 * applies per-tenant quota.
 *
 * Direct mode replaces this with the concrete `OpenAIProvider` from
 * `providers/ai-openai/`.
 */

import type { AIInferenceProvider, Capability } from '../capabilities';
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
  }): Promise<unknown> {
    return this.client.parseScreenshot({
      providerKey: this.providerKey,
      imageBase64: input.imageBase64,
      mimeType: input.mimeType,
      hint: input.hint,
    });
  }

  async parseDocumentText(text: string, hint?: string): Promise<unknown> {
    return this.client.parseDocumentText({
      providerKey: this.providerKey,
      text,
      hint,
    });
  }

  async completeText(
    prompt: string,
    opts?: { temperature?: number; maxTokens?: number }
  ): Promise<string> {
    return this.client.completeText({
      providerKey: this.providerKey,
      prompt,
      temperature: opts?.temperature,
      maxTokens: opts?.maxTokens,
    });
  }
}

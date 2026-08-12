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
 *
 * **Capabilities are declared, never assumed.** A prompt whose schema
 * the remote would overwrite (`systemPrompt`) and a document type the
 * remote can't read (`application/pdf`) are both refused HERE, before
 * the call, based on what `ai.status` says the remote supports. The
 * alternative — send it and hope — is what made invoice extraction bill
 * for a call and return zero invoices: the response was valid JSON in
 * the holdings schema, so nothing anywhere raised an error.
 */

import type { AIInferenceProvider, AIResult, Capability } from '../capabilities';
import type { CloudAICapabilities, CloudProviderClient } from './cloud-client';

const PDF_MIME_TYPE = 'application/pdf';

export class CloudAIProvider implements AIInferenceProvider {
  readonly capabilities: readonly Capability[] = ['ai-inference'];

  /** Resolved over the wire, so the synchronous declaration stays
      undefined — `parseScreenshot` enforces it per call instead. */
  readonly supportsPdfFileInput = undefined;

  /** One `ai.status` round trip per process, not per call. Held as the
      promise so concurrent first calls share it. */
  private remote: Promise<CloudAICapabilities> | null = null;

  constructor(
    readonly providerKey: string,
    private readonly client: CloudProviderClient
  ) {}

  async parseScreenshot(input: {
    imageBase64: string;
    mimeType: string;
    hint?: string;
    systemPrompt?: string;
  }): Promise<AIResult<unknown>> {
    const isPdf = input.mimeType === PDF_MIME_TYPE;
    // Probed only when something actually has to be declared. An image
    // parse with the default schema — the path with real callers today —
    // keeps costing exactly one round trip.
    if (input.systemPrompt || isPdf) {
      const remote = await this.resolveRemoteCapabilities();
      if (input.systemPrompt) this.requireSystemPrompt(remote);
      if (isPdf && !remote.pdfFileInput) {
        throw new Error(
          `${this.providerKey}: PDF input not supported over the cloud AI route — the data-provider does not declare pdfFileInput for this provider key`
        );
      }
    }
    const payload = await this.client.parseScreenshot({
      providerKey: this.providerKey,
      imageBase64: input.imageBase64,
      mimeType: input.mimeType,
      hint: input.hint,
      systemPrompt: input.systemPrompt,
    });
    return { data: this.unwrap(payload, input.systemPrompt) };
  }

  async parseDocumentText(
    text: string,
    hint?: string,
    systemPrompt?: string
  ): Promise<AIResult<unknown>> {
    if (systemPrompt) this.requireSystemPrompt(await this.resolveRemoteCapabilities());
    const payload = await this.client.parseDocumentText({
      providerKey: this.providerKey,
      text,
      hint,
      systemPrompt,
    });
    return { data: this.unwrap(payload, systemPrompt) };
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

  private requireSystemPrompt(remote: CloudAICapabilities): void {
    if (remote.systemPrompt) return;
    throw new Error(
      `${this.providerKey}: systemPrompt not supported over the cloud AI route — the data-provider would normalize the response into the holdings schema`
    );
  }

  private resolveRemoteCapabilities(): Promise<CloudAICapabilities> {
    // A failed probe is not cached: the next call retries rather than
    // pinning the provider to "unsupported" for the life of the process
    // because of one blip.
    this.remote ??= this.client
      .fetchAICapabilities({ providerKey: this.providerKey })
      .catch((err: unknown) => {
        this.remote = null;
        throw err;
      });
    return this.remote;
  }

  /**
   * The route answers `{ raw, metadata }` when a `systemPrompt` governed
   * the response and `{ portfolio, metadata }` when the holdings schema
   * did. Unwrapping to the bare payload is what makes this proxy
   * substitutable for `OpenAIProvider`, whose `data` is the model's own
   * object — `AIRouter` and `InvoiceExtractionService` both read it that
   * way, and the wrapper used to reach them intact, so a cloud-mode
   * screenshot parse normalized `{portfolio, metadata}` and found no
   * holdings on it.
   */
  private unwrap(payload: unknown, systemPrompt: string | undefined): unknown {
    const record =
      typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : null;
    if (!record) return payload;
    if (systemPrompt) {
      if ('raw' in record) return record.raw;
      // It declared support and then normalized anyway. Refusing beats
      // handing the caller an empty holdings object it will read as
      // "the document contained nothing".
      if ('portfolio' in record) {
        throw new Error(
          `${this.providerKey}: data-provider returned a holdings-shaped response to a systemPrompt request — its declared systemPrompt support is wrong`
        );
      }
      return payload;
    }
    return 'portfolio' in record ? record.portfolio : payload;
  }
}

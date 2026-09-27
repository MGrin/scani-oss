import type { NewToken, Token, TokenMetadata } from '@scani/db/schema';
import type {
  AIInferenceProvider,
  AIResult,
  Capability,
  HistoricalPriceProvider,
  TokenIdentityProvider,
} from '@scani/providers/core/capabilities';
import {
  cloudMetadataSchema,
  type cloudPricingProviderSchema,
  toCloudAsset,
} from '@scani/providers/core/cloud-contract';
import type { PriceQuote, ProviderContext } from '@scani/providers/core/types';
import type { CloudClient } from '../client';

type PricingKey = (typeof cloudPricingProviderSchema.options)[number];

export class CloudPricingProvider implements HistoricalPriceProvider {
  readonly capabilities: readonly Capability[] = ['current-price', 'historical-price'];
  constructor(
    private readonly client: CloudClient,
    readonly providerKey: PricingKey
  ) {
    if (providerKey !== 'kraken') this.fetchHistoricalRange = this.fetchRange.bind(this);
  }
  readonly fetchHistoricalRange?: HistoricalPriceProvider['fetchHistoricalRange'];
  canPrice(_token: Token): boolean {
    return true;
  }
  async fetchCurrentPrice(token: Token, ctx: ProviderContext): Promise<PriceQuote | null> {
    return (await this.fetchCurrentPrices([token], ctx)).get(token.id) ?? null;
  }
  async fetchCurrentPrices(
    tokens: Token[],
    ctx: ProviderContext
  ): Promise<Map<string, PriceQuote>> {
    const result = new Map<string, PriceQuote>();
    for (let offset = 0; offset < tokens.length; offset += 100) {
      const rows = await this.client.processing.v1.prices.mutate({
        provider: this.providerKey,
        tokens: tokens.slice(offset, offset + 100).map(toCloudAsset),
        baseCurrency: toCloudAsset(ctx.baseCurrency),
      });
      for (const row of rows)
        result.set(row.tokenId, { ...row, timestamp: new Date(row.timestamp) });
    }
    return result;
  }
  async fetchHistoricalPrice(
    token: Token,
    at: Date,
    ctx: ProviderContext
  ): Promise<PriceQuote | null> {
    const rows = await this.client.processing.v1.prices.mutate({
      provider: this.providerKey,
      tokens: [toCloudAsset(token)],
      baseCurrency: toCloudAsset(ctx.baseCurrency),
      at: at.toISOString(),
    });
    const row = rows[0];
    return row ? { ...row, timestamp: new Date(row.timestamp) } : null;
  }
  private async fetchRange(
    token: Token,
    from: Date,
    to: Date,
    ctx: ProviderContext
  ): Promise<PriceQuote[]> {
    const rows: PriceQuote[] = [];
    for (let start = from.getTime(); start <= to.getTime(); ) {
      const end = Math.min(start + 365 * 86_400_000, to.getTime());
      const page = await this.client.processing.v1.range.mutate({
        provider: this.providerKey,
        token: toCloudAsset(token),
        baseCurrency: toCloudAsset(ctx.baseCurrency),
        from: new Date(start).toISOString(),
        to: new Date(end).toISOString(),
      });
      rows.push(...page.map((row) => ({ ...row, timestamp: new Date(row.timestamp) })));
      start = end + 86_400_000;
    }
    return rows;
  }
}

export class CloudIdentityProvider implements TokenIdentityProvider {
  readonly capabilities: readonly Capability[] = ['token-identity'];
  constructor(
    private readonly client: CloudClient,
    readonly providerKey: string
  ) {}
  async enrichTokenIdentity(
    partial: Partial<NewToken>,
    opts?: { force?: boolean }
  ): Promise<Partial<TokenMetadata> | null> {
    const raw =
      typeof partial.providerMetadata === 'string'
        ? JSON.parse(partial.providerMetadata)
        : partial.providerMetadata;
    return this.client.tokens.enrichIdentity.mutate({
      providerKey: this.providerKey,
      partial: {
        symbol: partial.symbol,
        name: partial.name,
        decimals: partial.decimals ?? undefined,
        providerMetadata: cloudMetadataSchema.strip().parse(raw ?? {}),
      },
      force: opts?.force,
    });
  }
}

export class CloudAIProvider implements AIInferenceProvider {
  readonly providerKey = 'ai-cloud';
  readonly capabilities: readonly Capability[] = ['ai-inference'];
  readonly supportsPdfFileInput = true;
  constructor(private readonly client: CloudClient) {}
  async parseScreenshot(
    input: Parameters<AIInferenceProvider['parseScreenshot']>[0]
  ): Promise<AIResult<unknown>> {
    const result = await this.client.processing.v1.ai.mutate({
      operation: 'screenshot',
      ...input,
      mimeType: input.mimeType as
        | 'image/png'
        | 'image/jpeg'
        | 'image/webp'
        | 'image/gif'
        | 'application/pdf',
    });
    return { data: result.data, usage: result.usage };
  }
  async parseDocumentText(
    text: string,
    hint?: string,
    systemPrompt?: string
  ): Promise<AIResult<unknown>> {
    const result = await this.client.processing.v1.ai.mutate({
      operation: 'document',
      text,
      hint,
      systemPrompt,
    });
    return { data: result.data, usage: result.usage };
  }
  async completeText(
    prompt: string,
    opts?: { temperature?: number; maxTokens?: number }
  ): Promise<AIResult<string>> {
    const result = await this.client.processing.v1.ai.mutate({
      operation: 'complete',
      prompt,
      ...opts,
    });
    if (typeof result.data !== 'string') throw new Error('Invalid cloud completion response');
    return { ...result, data: result.data };
  }
}

import type { NewToken, Token, TokenMetadata } from '@scani/db/schema';
import type { CloudProviderClient } from '@scani/providers/core/cloud';
import { ProviderError } from '@scani/providers/core/errors';
import type { HoldingSnapshot, PriceQuote, TransactionEvent } from '@scani/providers/core/types';
import type { CloudClient } from '../client';
import { CloudError } from '../errors';

// Bridges @scani/providers' CloudProviderClient interface to a typed
// CloudClient (tRPC over the data-provider). Backend / worker boot
// constructs this and passes it to buildProviderRegistry({ mode: 'cloud',
// cloudClient: bridge }).
//
// tRPC serializes Date as ISO string over the wire; PriceQuote.timestamp
// is typed as Date so consumers can do arithmetic. `hydrateQuote` re-parses
// the string after every pricing.* mutation result.

function hydrateQuote<T extends { timestamp: string | Date }>(
  q: T
): Omit<T, 'timestamp'> & { timestamp: Date } {
  return { ...q, timestamp: q.timestamp instanceof Date ? q.timestamp : new Date(q.timestamp) };
}
//
// Live procedures: ai.{parseScreenshot,parseDocumentText,completeText},
// pricing.{fetchCurrentPrice,fetchCurrentPrices,fetchHistoricalPrice,
// fetchHistoricalRange}, tokens.enrichIdentity.
//
// fetchBalances/fetchTransactions stay throwing `not-supported`. They're
// user-credentialed venues (CEXes, brokers) — the data-provider only
// boots Scani-credentialed providers + public-endpoint chain providers,
// and routing user creds through the data-provider would require the
// backend to send decrypted creds over the wire on every balance sync,
// which is the architectural boundary we're keeping. Backend in cloud
// mode keeps a direct-mode sub-registry for those venues.
export class CloudProviderClientBridge implements CloudProviderClient {
  constructor(private readonly client: CloudClient) {}

  // ============================================================
  // Pricing — live via data-provider's pricing.* router.
  // ============================================================
  async fetchCurrentPrice(args: {
    providerKey: string;
    token: Token;
    baseCurrencyId: string;
  }): Promise<PriceQuote | null> {
    try {
      const baseCurrency = synthBaseCurrency(args.baseCurrencyId, args.token);
      const result = await this.client.pricing.fetchCurrentPrice.mutate({
        providerKey: args.providerKey,
        token: serializeToken(args.token),
        baseCurrency: serializeToken(baseCurrency),
      });
      return result ? hydrateQuote(result) : null;
    } catch (err) {
      throw CloudError.wrap(err);
    }
  }

  async fetchCurrentPrices(args: {
    providerKey: string;
    tokens: Token[];
    baseCurrencyId: string;
  }): Promise<Array<{ tokenId: string; quote: PriceQuote }>> {
    if (args.tokens.length === 0) return [];
    try {
      const baseCurrency = synthBaseCurrency(args.baseCurrencyId, args.tokens[0] as Token);
      const result = await this.client.pricing.fetchCurrentPrices.mutate({
        providerKey: args.providerKey,
        tokens: args.tokens.map(serializeToken),
        baseCurrency: serializeToken(baseCurrency),
      });
      return result.map((r) => ({ tokenId: r.tokenId, quote: hydrateQuote(r.quote) }));
    } catch (err) {
      throw CloudError.wrap(err);
    }
  }

  async fetchHistoricalPrice(args: {
    providerKey: string;
    token: Token;
    at: Date;
    baseCurrencyId: string;
  }): Promise<PriceQuote | null> {
    try {
      const baseCurrency = synthBaseCurrency(args.baseCurrencyId, args.token);
      const result = await this.client.pricing.fetchHistoricalPrice.mutate({
        providerKey: args.providerKey,
        token: serializeToken(args.token),
        at: args.at,
        baseCurrency: serializeToken(baseCurrency),
      });
      return result ? hydrateQuote(result) : null;
    } catch (err) {
      throw CloudError.wrap(err);
    }
  }

  async fetchHistoricalRange(args: {
    providerKey: string;
    token: Token;
    from: Date;
    to: Date;
    baseCurrencyId: string;
  }): Promise<PriceQuote[]> {
    try {
      const baseCurrency = synthBaseCurrency(args.baseCurrencyId, args.token);
      const result = await this.client.pricing.fetchHistoricalRange.mutate({
        providerKey: args.providerKey,
        token: serializeToken(args.token),
        from: args.from,
        to: args.to,
        baseCurrency: serializeToken(baseCurrency),
      });
      return result.map(hydrateQuote);
    } catch (err) {
      throw CloudError.wrap(err);
    }
  }

  // ============================================================
  // Balances + transactions — intentionally not implemented in
  // cloud mode. See class header for rationale.
  // ============================================================
  async fetchBalances(_args: {
    institutionCode: string;
    userId: string;
    institutionId: string;
    baseCurrencyId: string;
    accountId?: string;
  }): Promise<HoldingSnapshot[]> {
    throw notSupported('fetchBalances');
  }

  async fetchTransactions(_args: {
    institutionCode: string;
    userId: string;
    institutionId: string;
    baseCurrencyId: string;
    accountId?: string;
    since?: Date;
    until?: Date;
  }): Promise<TransactionEvent[]> {
    throw notSupported('fetchTransactions');
  }

  // ============================================================
  // Token identity — live via data-provider's tokens.enrichIdentity.
  // ============================================================
  async enrichTokenIdentity(args: {
    providerKey: string;
    partial: Partial<NewToken>;
    force?: boolean;
  }): Promise<Partial<TokenMetadata> | null> {
    try {
      const result = await this.client.tokens.enrichIdentity.mutate({
        providerKey: args.providerKey,
        partial: args.partial as Record<string, unknown>,
        force: args.force,
      });
      return result as Partial<TokenMetadata> | null;
    } catch (err) {
      throw CloudError.wrap(err);
    }
  }

  // ============================================================
  // AI — live (data-provider has matching ai.* routes today).
  // ============================================================
  async parseScreenshot(args: {
    providerKey: string;
    imageBase64: string;
    mimeType: string;
    hint?: string;
  }): Promise<unknown> {
    try {
      return await this.client.ai.parseScreenshot.mutate({
        imageBase64: args.imageBase64,
        options: {
          provider: args.providerKey,
          mimeType: args.mimeType,
          context: args.hint,
        },
      });
    } catch (err) {
      throw CloudError.wrap(err);
    }
  }

  async parseDocumentText(args: {
    providerKey: string;
    text: string;
    hint?: string;
  }): Promise<unknown> {
    try {
      return await this.client.ai.parseDocumentText.mutate({
        text: args.text,
        options: {
          provider: args.providerKey,
          context: args.hint,
        },
      });
    } catch (err) {
      throw CloudError.wrap(err);
    }
  }

  async completeText(args: {
    providerKey: string;
    prompt: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<string> {
    try {
      const out = await this.client.ai.completeText.mutate({
        prompt: args.prompt,
        options: {
          provider: args.providerKey,
          temperature: args.temperature,
          maxTokens: args.maxTokens,
        },
      });
      return typeof out === 'string' ? out : String(out);
    } catch (err) {
      throw CloudError.wrap(err);
    }
  }
}

function notSupported(method: string): ProviderError {
  return new ProviderError(
    `cloud-mode bridge: ${method} is intentionally not routed through data-provider — keep these venues in direct mode (see @scani/providers README follow-ups).`,
    'not-supported',
    'cloud-bridge'
  );
}

/**
 * Reduce a Drizzle Token row to the wire shape data-provider's pricing
 * router accepts (`v2TokenSchema`). The shape is structurally compatible
 * with `Token` and routes `providerMetadata` as JSONB (an object, not
 * a stringified payload).
 */
function serializeToken(t: Token): {
  id: string;
  symbol: string;
  name: string;
  typeId: string;
  decimals: number;
  iconUrl: string | null;
  providerMetadata: unknown;
  isScamProbability: number;
  isActive: boolean;
  marketSegment: string | null;
  createdAt: Date;
  updatedAt: Date;
} {
  return {
    id: t.id,
    symbol: t.symbol,
    name: t.name,
    typeId: t.typeId,
    decimals: t.decimals,
    iconUrl: t.iconUrl,
    providerMetadata: t.providerMetadata,
    isScamProbability: t.isScamProbability,
    isActive: t.isActive,
    marketSegment: t.marketSegment ?? null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

/**
 * Cloud bridge accepts only `baseCurrencyId` (a token id), not the full
 * Token row. Pricing providers in data-provider need a Token-shaped
 * object on the wire because `ProviderContext.baseCurrency` is typed
 * as `Token`. We synthesize a minimal stand-in: real CoinGecko /
 * DeFiLlama / Frankfurter pricing logic only reads
 * `baseCurrency.symbol` (and sometimes `id`); the rest of the fields
 * are filler that satisfies the shape without affecting behavior.
 *
 * `seed` provides typeId/marketSegment defaults so the synthetic row
 * matches the calling token's category — keeps the wire serializer
 * happy without us having to plumb a fiat/crypto distinction.
 */
function synthBaseCurrency(baseCurrencyId: string, seed: Token): Token {
  return {
    ...seed,
    id: baseCurrencyId,
    symbol: baseCurrencyId.toUpperCase().slice(0, 8),
    name: baseCurrencyId,
    providerMetadata: {},
  };
}

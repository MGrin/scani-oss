import { cached } from '../cache';
import { type Result, tryCatch } from '../result';
import { redisPipeline } from './queue-redis';

/**
 * 28 third-party provider integrations under
 * `packages/clients/providers/src/providers/*`. The list is hardcoded
 * here (rather than imported from `@scani/providers`) on purpose —
 * importing the registry would pull every provider's HTTP client into
 * the admin's edge bundle, and a handful of those clients reach for
 * Node-only APIs. The directory listing is the source of truth; this
 * file mirrors it. When a provider is added, add an entry here.
 *
 * Rate-limit budget is read from the `@scani/rate-limiter` outflow
 * ZSETs that the providers themselves write to. For pool/self
 * providers the key is `rl:<key>`; for user-credentialed providers
 * the limiter shards per-user (`rl:<key>:<userId>`) so a single ZCARD
 * doesn't represent the whole population — we report `null` rather
 * than a misleading number.
 */

export type ProviderCategory =
  | 'pricing-current'
  | 'pricing-historical'
  | 'forex'
  | 'stocks'
  | 'balances-cex'
  | 'balances-brokerage'
  | 'blockchain'
  | 'token-identity'
  | 'ai';

export type CredentialStyle = 'pool' | 'user' | 'self';

export interface ProviderCatalogEntry {
  key: string;
  name: string;
  categories: ProviderCategory[];
  credential: CredentialStyle;
  /** Marketing/operator-facing one-liner. */
  description: string;
}

/**
 * Canonical catalog. Order is alphabetical-by-key within each grouping
 * the UI cares about, but the page is free to re-sort.
 */
export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  // --- AI providers (Scani-owned credentials) ---
  {
    key: 'ai-openai',
    name: 'OpenAI',
    categories: ['ai'],
    credential: 'self',
    description: 'GPT-class inference for AI screenshot parse + chat features.',
  },
  {
    key: 'ai-deepseek',
    name: 'DeepSeek',
    categories: ['ai'],
    credential: 'self',
    description: 'Lower-cost LLM inference for backfill workloads.',
  },
  {
    key: 'ai-perplexity',
    name: 'Perplexity',
    categories: ['ai'],
    credential: 'self',
    description: 'Search-grounded LLM for token-identity enrichment.',
  },
  // --- Pricing / pool-credentialed ---
  {
    key: 'coingecko',
    name: 'CoinGecko',
    categories: ['pricing-current', 'pricing-historical', 'token-identity'],
    credential: 'pool',
    description: 'Primary spot/historical pricing + token catalog source.',
  },
  {
    key: 'defillama',
    name: 'DeFiLlama',
    categories: ['pricing-current', 'pricing-historical', 'token-identity'],
    credential: 'pool',
    description: 'DeFi-native pricing + LP/yield token coverage.',
  },
  {
    key: 'frankfurter',
    name: 'Frankfurter',
    categories: ['forex'],
    credential: 'pool',
    description: 'ECB-published FX rates (no API key required).',
  },
  {
    key: 'finnhub',
    name: 'Finnhub',
    categories: ['stocks'],
    credential: 'pool',
    description: 'Equities + ETFs spot pricing.',
  },
  {
    key: 'yahoo-finance',
    name: 'Yahoo Finance',
    categories: ['stocks', 'forex'],
    credential: 'pool',
    description: 'Fallback equities + FX pricing source.',
  },
  // --- Blockchain (pool / public RPC) ---
  {
    key: 'etherscan',
    name: 'Etherscan',
    categories: ['blockchain'],
    credential: 'pool',
    description: 'EVM-chain transactions + balances via Etherscan family of explorers.',
  },
  {
    key: 'bitcoin',
    name: 'Bitcoin (mempool.space)',
    categories: ['blockchain'],
    credential: 'pool',
    description: 'UTXO + transaction history for BTC addresses.',
  },
  {
    key: 'solana',
    name: 'Solana (Helius / RPC)',
    categories: ['blockchain'],
    credential: 'pool',
    description: 'SOL + SPL-token balances and transactions.',
  },
  {
    key: 'tron',
    name: 'TRON (TronGrid)',
    categories: ['blockchain'],
    credential: 'pool',
    description: 'TRX + TRC-20 balances and transactions.',
  },
  {
    key: 'ton',
    name: 'TON (Toncenter)',
    categories: ['blockchain'],
    credential: 'pool',
    description: 'TON + jetton balances and transactions.',
  },
  // --- CEX exchanges (user-credentialed) ---
  {
    key: 'binance',
    name: 'Binance',
    categories: ['balances-cex'],
    credential: 'user',
    description: 'Spot + earn + funding wallet balances. Read-only API keys.',
  },
  {
    key: 'bitget',
    name: 'Bitget',
    categories: ['balances-cex'],
    credential: 'user',
    description: 'Spot + earn balances.',
  },
  {
    key: 'bitstamp',
    name: 'Bitstamp',
    categories: ['balances-cex'],
    credential: 'user',
    description: 'Spot balances.',
  },
  {
    key: 'bybit',
    name: 'Bybit',
    categories: ['balances-cex'],
    credential: 'user',
    description: 'Unified-account spot + derivatives margin balances.',
  },
  {
    key: 'coinbase',
    name: 'Coinbase',
    categories: ['balances-cex'],
    credential: 'user',
    description: 'Coinbase Advanced + Coinbase Wallet balances.',
  },
  {
    key: 'gate',
    name: 'Gate.io',
    categories: ['balances-cex'],
    credential: 'user',
    description: 'Spot + earn balances.',
  },
  {
    key: 'gemini',
    name: 'Gemini',
    categories: ['balances-cex'],
    credential: 'user',
    description: 'Spot + Gemini Earn balances.',
  },
  {
    key: 'huobi',
    name: 'Huobi / HTX',
    categories: ['balances-cex'],
    credential: 'user',
    description: 'Spot + earn balances.',
  },
  {
    key: 'kraken',
    name: 'Kraken',
    categories: ['balances-cex'],
    credential: 'user',
    description: 'Spot + staking balances.',
  },
  {
    key: 'kucoin',
    name: 'KuCoin',
    categories: ['balances-cex'],
    credential: 'user',
    description: 'Spot + funding balances.',
  },
  {
    key: 'mexc',
    name: 'MEXC',
    categories: ['balances-cex'],
    credential: 'user',
    description: 'Spot balances.',
  },
  {
    key: 'okx',
    name: 'OKX',
    categories: ['balances-cex'],
    credential: 'user',
    description: 'Unified-account balances.',
  },
  // --- Brokerage / banking (user-credentialed) ---
  {
    key: 'ibkr',
    name: 'Interactive Brokers',
    categories: ['balances-brokerage'],
    credential: 'user',
    description: 'Equities + ETFs + cash via IBKR Web API.',
  },
  {
    key: 'wise',
    name: 'Wise',
    categories: ['balances-brokerage'],
    credential: 'user',
    description: 'Multi-currency banking balances + transactions.',
  },
];

export interface ProviderRow extends ProviderCatalogEntry {
  /**
   * Current-window usage count from `rl:<key>` ZSET.
   * - pool/self → ZCARD on the single shared window.
   * - user → null (limiter is sharded per-user; ZCARD on one key isn't representative).
   */
  rateLimitWindow: number | null;
}

export async function getProviderCatalog(): Promise<Result<ProviderRow[]>> {
  return tryCatch(() =>
    cached('providers:catalog', 30, async () => {
      const sharedKeys = PROVIDER_CATALOG.filter(
        (p) => p.credential === 'pool' || p.credential === 'self'
      );

      // One pipelined round-trip for every shared-window probe. Empty
      // ZCARDs return 0 — no need to handle 'key does not exist'
      // specially.
      const counts = sharedKeys.length
        ? await redisPipeline(sharedKeys.map((p) => ['ZCARD', `rl:${p.key}`]))
        : [];
      const countByKey = new Map<string, number>();
      sharedKeys.forEach((p, i) => {
        countByKey.set(p.key, Number(counts[i]) || 0);
      });

      return PROVIDER_CATALOG.map((p) => ({
        ...p,
        rateLimitWindow:
          p.credential === 'pool' || p.credential === 'self' ? (countByKey.get(p.key) ?? 0) : null,
      }));
    })
  );
}

/**
 * Per-provider drill-down. Returns the catalog entry plus its shared
 * rate-limit window if applicable. Drilldown into user-credentialed
 * providers is a Phase-2.x follow-up (needs Redis SCAN with limit
 * to enumerate per-user keys safely).
 */
export async function getProviderDetail(
  key: string
): Promise<Result<{ entry: ProviderRow } | null>> {
  return tryCatch(async () => {
    const entry = PROVIDER_CATALOG.find((p) => p.key === key);
    if (!entry) return null;
    let rateLimitWindow: number | null = null;
    if (entry.credential === 'pool' || entry.credential === 'self') {
      const [card] = await redisPipeline([['ZCARD', `rl:${entry.key}`]]);
      rateLimitWindow = Number(card) || 0;
    }
    return { entry: { ...entry, rateLimitWindow } };
  });
}

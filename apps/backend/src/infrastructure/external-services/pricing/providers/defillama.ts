/**
 * DeFiLlama Pricing Provider
 *
 * Provides token prices from DeFiLlama API as a fallback when CoinGecko doesn't have the token.
 * DeFiLlama aggregates price data from 100+ chains and multiple sources (DEXes + CEXes).
 *
 * API Docs: https://defillama.com/docs/api
 * Free tier, no API key required
 */

import { PROVIDER_CONFIGS } from '../provider-config';
import type { ProviderPriceResult, TokenWithProvider } from '../types';
import type { RateLimiter } from '../utils';
import { fetchWithTimeout } from '../utils';
import type {
  ConvertPriceFn,
  CreateFailureResultFn,
  PricingProvider,
  ProviderExecutionContext,
} from './base';

/**
 * Mapping of chainId to DeFiLlama chain names
 * See: https://defillama.com/docs/api
 */
const CHAIN_ID_TO_DEFILLAMA: Record<number, string> = {
  1: 'ethereum',
  10: 'optimism',
  56: 'bsc',
  100: 'xdai', // Gnosis Chain (formerly xDai)
  137: 'polygon',
  250: 'fantom',
  324: 'era', // zkSync Era
  8453: 'base',
  42161: 'arbitrum',
  43114: 'avax',
  59144: 'linea',
  534352: 'scroll',
  // Add more chains as needed
};

/**
 * DeFiLlama API response format
 */
interface DeFiLlamaResponse {
  coins: {
    [key: string]: {
      decimals: number;
      symbol: string;
      price: number;
      timestamp: number;
      confidence: number;
    };
  };
}

interface DeFiLlamaProviderDependencies {
  rateLimiter: RateLimiter;
  convertPrice: ConvertPriceFn;
  createFailureResult: CreateFailureResultFn;
}

export class DeFiLlamaProvider implements PricingProvider {
  readonly key = 'defiLlama';
  private readonly MIN_CONFIDENCE = 0.8;

  constructor(private readonly deps: DeFiLlamaProviderDependencies) {}

  async fetchPrices(
    tokens: TokenWithProvider[],
    { baseCurrency, timestamp }: ProviderExecutionContext
  ): Promise<ProviderPriceResult[]> {
    if (tokens.length === 0) {
      return [];
    }

    const { rateLimiter, convertPrice, createFailureResult } = this.deps;
    const results: ProviderPriceResult[] = [];

    // DeFiLlama requires individual requests per token (batch endpoint not available)
    for (const { token, providerTokenId } of tokens) {
      // providerTokenId format: "chainId:address" (e.g., "1:0x...")
      const [chainIdStr, contractAddress] = (providerTokenId || '').split(':');

      if (!chainIdStr || !contractAddress) {
        results.push(
          createFailureResult(
            token.id,
            timestamp,
            PROVIDER_CONFIGS.defiLlama.name,
            new Error('Invalid providerTokenId format, expected "chainId:address"')
          )
        );
        continue;
      }

      const chainId = Number.parseInt(chainIdStr, 10);
      const chainName = CHAIN_ID_TO_DEFILLAMA[chainId];

      if (!chainName) {
        results.push(
          createFailureResult(
            token.id,
            timestamp,
            PROVIDER_CONFIGS.defiLlama.name,
            new Error(`Chain ${chainId} not supported by DeFiLlama`)
          )
        );
        continue;
      }

      try {
        const key = `${chainName}:${contractAddress.toLowerCase()}`;
        const url = `https://coins.llama.fi/prices/current/${key}`;

        const response = await rateLimiter.execute(async () =>
          fetchWithTimeout(url, {
            headers: { 'Content-Type': 'application/json' },
          })
        );

        if (!response.ok) {
          results.push(
            createFailureResult(
              token.id,
              timestamp,
              PROVIDER_CONFIGS.defiLlama.name,
              new Error(`DeFiLlama API responded with ${response.status}`),
              { response }
            )
          );
          continue;
        }

        const data = (await response.json()) as DeFiLlamaResponse;
        const tokenData = data.coins?.[key];

        if (!tokenData) {
          results.push(
            createFailureResult(
              token.id,
              timestamp,
              PROVIDER_CONFIGS.defiLlama.name,
              new Error('Token not found on DeFiLlama'),
              { response, dataEmpty: true }
            )
          );
          continue;
        }

        // Check confidence score (0-1 scale, higher is better)
        if (tokenData.confidence < this.MIN_CONFIDENCE) {
          results.push(
            createFailureResult(
              token.id,
              timestamp,
              PROVIDER_CONFIGS.defiLlama.name,
              new Error(`Low confidence score: ${tokenData.confidence}`),
              { response }
            )
          );
          continue;
        }

        let finalPrice = tokenData.price.toString();

        // Convert from USD to target currency if needed
        if (baseCurrency.symbol.toUpperCase() !== 'USD') {
          finalPrice = await convertPrice(
            finalPrice,
            'USD',
            baseCurrency.symbol.toUpperCase(),
            timestamp
          );

          if (finalPrice === '0') {
            results.push({
              tokenId: token.id,
              price: '0',
              timestamp,
              source: `${PROVIDER_CONFIGS.defiLlama.name}_conversion_failed`,
            });
            continue;
          }
        }

        results.push({
          tokenId: token.id,
          price: finalPrice,
          timestamp,
          source: PROVIDER_CONFIGS.defiLlama.name,
        });
      } catch (error) {
        results.push(
          createFailureResult(token.id, timestamp, PROVIDER_CONFIGS.defiLlama.name, error)
        );
      }
    }

    return results;
  }
}

/**
 * Check if token is likely spam based on name/symbol patterns
 * This utility is used in wallet import to filter out obvious spam before pricing
 *
 * @param token - Token with name and symbol
 * @returns True if token appears to be spam
 */
export function isLikelySpamToken(token: { name: string; symbol: string }): boolean {
  const suspiciousPatterns = [
    /https?:\/\//i, // Contains URL
    /www\./i, // Contains www.
    /\.com|\.xyz|\.cc|\.io|\.app|\.eu/i, // Domain extensions
    /claim|visit|reward|bonus|airdrop/i, // Scam keywords
    /^\$/, // Starts with $
    /t\.me|telegram/i, // Telegram references
    /swap.*on|claim.*on/i, // "Swap on" or "Claim on" patterns
  ];

  const nameMatch = suspiciousPatterns.some((pattern) => pattern.test(token.name));
  const symbolMatch = suspiciousPatterns.some((pattern) => pattern.test(token.symbol));

  return nameMatch || symbolMatch;
}

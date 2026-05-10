/**
 * Tokens router — exposes the federated token-identity + search flows
 * over tRPC for cloud-mode callers.
 *
 * Backend / worker in cloud mode call this router instead of holding
 * their own CoinGecko / DeFiLlama / Finnhub clients. The data-provider's
 * registry already has all three identity enrichers registered at boot,
 * so this router just dispatches by `providerKey` (for enrichIdentity)
 * or fans out across all enrichers that implement `searchTokens`
 * (for search).
 */

import { createComponentLogger } from '@scani/logging';
import type { TokenSearchResult } from '@scani/providers/core/capabilities';
import { ProviderRegistry } from '@scani/providers/core/registry';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { bearerProcedure, router } from '../trpc';

const log = createComponentLogger('data-provider:tokens');

export const tokensRouter = router({
  /**
   * Free-text token search across every identity-enricher provider that
   * implements `searchTokens`. Backs the api `tokens.search` flow used
   * by manual holding creation + token autocomplete; no upstream API
   * keys leak to the api app.
   *
   * Per-provider failures are isolated via `Promise.allSettled` so a
   * single slow provider can't gate the whole response. Per-provider
   * results are returned uninterpreted; the caller decides how to
   * dedupe / prioritize against its own DB.
   */
  search: bearerProcedure
    .meta({
      openapi: {
        method: 'GET',
        path: '/trpc/tokens.search',
        tags: ['tokens'],
        summary: 'Free-text token search across CoinGecko, DeFiLlama, Finnhub',
        protect: true,
      },
    })
    .input(
      z.object({
        query: z.string().min(1).max(100),
        limit: z.number().int().min(1).max(50).default(10),
      })
    )
    .output(z.unknown())
    .query(async ({ input }): Promise<TokenSearchResult[]> => {
      const enrichers = Container.get(ProviderRegistry)
        .getIdentityEnrichers()
        .filter(
          (p): p is typeof p & { searchTokens: NonNullable<typeof p.searchTokens> } =>
            typeof p.searchTokens === 'function'
        );
      if (enrichers.length === 0) return [];
      const settled = await Promise.allSettled(
        enrichers.map((p) => p.searchTokens(input.query, input.limit))
      );
      const merged: TokenSearchResult[] = [];
      const seen = new Set<string>();
      for (let i = 0; i < settled.length; i += 1) {
        const result = settled[i];
        const enricher = enrichers[i];
        if (!enricher) continue;
        if (result?.status === 'rejected') {
          log.warn(
            { provider: enricher.providerKey, err: String(result.reason), query: input.query },
            'searchTokens failed; continuing with other providers'
          );
          continue;
        }
        if (result?.status !== 'fulfilled') continue;
        for (const item of result.value) {
          // Dedupe on `provider:symbol` so the same crypto returned by
          // both CoinGecko and DeFiLlama doesn't appear twice; let the
          // caller dedupe further against its own DB if needed.
          const key = `${item.provider}:${item.symbol.toUpperCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(item);
        }
      }
      return merged.slice(0, input.limit * enrichers.length);
    }),

  enrichIdentity: bearerProcedure
    .meta({
      openapi: {
        method: 'POST',
        path: '/trpc/tokens.enrichIdentity',
        tags: ['tokens'],
        summary: 'Enrich a partial token record using a specific identity provider',
        protect: true,
      },
    })
    .input(
      z.object({
        providerKey: z.string(),
        // Partial<NewToken> — server is permissive, the consuming
        // provider only reads symbol / contract address fields.
        partial: z
          .object({
            symbol: z.string().optional(),
            name: z.string().optional(),
            decimals: z.number().optional(),
            providerMetadata: z.unknown().optional(),
          })
          .passthrough(),
        force: z.boolean().optional(),
      })
    )
    .output(z.unknown())
    .mutation(async ({ input }): Promise<unknown> => {
      const enricher = Container.get(ProviderRegistry)
        .getIdentityEnrichers()
        .find((p) => p.providerKey === input.providerKey);
      if (!enricher) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `data-provider has no registered identity enricher for key '${input.providerKey}'`,
        });
      }
      try {
        return await enricher.enrichTokenIdentity(input.partial as never, {
          force: input.force,
        });
      } catch (err) {
        log.warn(
          { providerKey: input.providerKey, partial: input.partial, err },
          'enrichTokenIdentity failed'
        );
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),
});

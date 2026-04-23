import {
  BitcoinChainService,
  type ChainConfig,
  EVM_CHAINS,
  EvmChainService,
  getChainConfig,
  type IBlockchainService,
  NON_EVM_CHAINS,
  SolanaChainService,
  TonChainService,
  TronChainService,
} from '@scani/integrations/blockchain-services';
import { createComponentLogger } from '@scani/logging';
import { config as pricingConfig } from '@scani/pricing-providers';
import { type IRateLimiter, RateLimiter } from '@scani/rate-limiter';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { bearerProcedure, router } from '../trpc';

/**
 * Chains router — owns all outbound blockchain RPC / explorer API calls.
 *
 * The rate limiters + provider API keys live here and here only; the
 * backend/worker talk to this surface through `CloudChainService` in
 * `@scani/cloud-client`. Keys (`ETHERSCAN_API_KEY`, `HELIUS_API_KEY`)
 * never have to leave this container, which is the core justification
 * for the split.
 */

const log = createComponentLogger('data-provider:chains');

// Co-located with the rate-limiter buckets they gate. Same namespaces as
// the old backend/worker wiring so that — when we cut over — the Redis
// keys stay the same and we don't accidentally get 2× the budget because
// two components suddenly share no state.
const CHAIN_RATE_LIMITERS: Record<string, IRateLimiter> = {
  etherscan: new RateLimiter(7, 1000, { namespace: 'etherscan' }),
  bitcoin: new RateLimiter(1, 10000, { namespace: 'bitcoin' }),
  solana: new RateLimiter(10, 1000, { namespace: 'solana' }),
  tron: new RateLimiter(20, 1000, { namespace: 'tron' }),
  ton: new RateLimiter(1, 1000, { namespace: 'ton' }),
};

// Cached per-chainId services; we never need two instances and the chain
// services hold internal state (HTTP agents, backoff timers) that we
// want to share across requests for connection reuse.
const serviceCache = new Map<string, IBlockchainService>();

function buildService(chainId: string | number): IBlockchainService | null {
  const cfg = getChainConfig(chainId);
  if (!cfg) return null;

  const key = String(chainId);
  const existing = serviceCache.get(key);
  if (existing) return existing;

  let built: IBlockchainService | null = null;

  if (cfg.type === 'evm') {
    built = new EvmChainService(cfg, {
      apiKey: pricingConfig.etherscan.apiKey,
      rateLimiter: CHAIN_RATE_LIMITERS.etherscan,
    });
  } else if (cfg.type === 'bitcoin') {
    built = new BitcoinChainService(cfg, {
      rateLimiter: CHAIN_RATE_LIMITERS.bitcoin,
    });
  } else if (cfg.type === 'solana') {
    built = new SolanaChainService(cfg, {
      rateLimiter: CHAIN_RATE_LIMITERS.solana,
    });
  } else if (cfg.type === 'tron') {
    built = new TronChainService(cfg, {
      rateLimiter: CHAIN_RATE_LIMITERS.tron,
    });
  } else if (cfg.type === 'ton') {
    built = new TonChainService(cfg, {
      rateLimiter: CHAIN_RATE_LIMITERS.ton,
    });
  }

  if (built) serviceCache.set(key, built);
  return built;
}

function resolve(chainId: string | number): IBlockchainService {
  const s = buildService(chainId);
  if (!s) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Unsupported chainId: ${chainId}`,
    });
  }
  return s;
}

const chainIdSchema = z.union([z.string(), z.number()]);

export const chainsRouter = router({
  /**
   * Returns every supported chain config. Backend uses this to seed the
   * address validators table without having to ship the chain list
   * in-process.
   */
  listConfigs: bearerProcedure.query((): ChainConfig[] => {
    return [
      ...Object.values(EVM_CHAINS).filter((c) => c.isActive),
      ...Object.values(NON_EVM_CHAINS).filter((c) => c.isActive),
    ];
  }),

  getTokenBalances: bearerProcedure
    .input(z.object({ chainId: chainIdSchema, address: z.string() }))
    .mutation(async ({ input }) => {
      try {
        return await resolve(input.chainId).getTokenBalances(input.address);
      } catch (err) {
        log.warn(
          {
            chainId: input.chainId,
            error: err instanceof Error ? err.message : String(err),
          },
          'getTokenBalances failed'
        );
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  hasActivity: bearerProcedure
    .input(z.object({ chainId: chainIdSchema, address: z.string() }))
    .mutation(async ({ input }) => {
      const svc = resolve(input.chainId);
      try {
        if (svc.hasActivity) return await svc.hasActivity(input.address);
        const balances = await svc.getTokenBalances(input.address);
        return balances.length > 0;
      } catch (err) {
        log.debug(
          {
            chainId: input.chainId,
            error: err instanceof Error ? err.message : String(err),
          },
          'hasActivity error, treating as no-activity'
        );
        return false;
      }
    }),

  resolveAddressName: bearerProcedure
    .input(z.object({ chainId: chainIdSchema, address: z.string() }))
    .mutation(async ({ input }): Promise<string | null> => {
      const svc = resolve(input.chainId);
      if (!svc.resolveAddressName) return null;
      try {
        return await svc.resolveAddressName(input.address);
      } catch {
        return null;
      }
    }),
});

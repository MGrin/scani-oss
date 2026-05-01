/**
 * Chains router — owns all outbound blockchain RPC / explorer API
 * calls.
 *
 * Dispatch goes through `Container.get(ProviderRegistry)` — every
 * chain provider in
 * `@scani/providers/providers/{etherscan,bitcoin,solana,tron,ton}`
 * implements `BalanceProvider` + `AddressValidatorProvider`. This
 * router translates `(chainId, address)` → `(institutionCode, ctx)`
 * and forwards into the registry.
 *
 * Why this stays in data-provider rather than going direct: API keys
 * (ETHERSCAN_API_KEY, HELIUS_API_KEY) live here, not in backend.
 * Backend talks to this surface via `@scani/cloud-client`.
 */

import type { Token } from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { ProviderRegistry } from '@scani/providers/core/registry';
import type { ProviderContext } from '@scani/providers/core/types';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { bearerProcedure, router } from '../trpc';

const log = createComponentLogger('data-provider:chains');

/**
 * `chainId` → registry institutionCode. Mirror of the catalog in
 * `WalletDiscoveryService` / `ETHERSCAN_CHAINS`. Inlined for the same
 * reason as in the worker's wallet-import processor: the list is
 * stable and depending on the providers package's chain catalog at
 * runtime is awkward (each provider doesn't expose its catalog).
 */
const EVM_CHAIN_ID_TO_INSTITUTION_CODE: Record<string, string> = {
  '1': 'ethereum',
  '56': 'bsc',
  '137': 'polygon',
  '43114': 'avalanche',
  '42161': 'arbitrum',
  '10': 'optimism',
  '8453': 'base',
  '250': 'fantom',
  '25': 'cronos',
  '42170': 'arbitrum-nova',
  '324': 'zksync-era',
  '534352': 'scroll',
  '59144': 'linea',
  '81457': 'blast',
  '5000': 'mantle',
  '204': 'opbnb',
  '100': 'gnosis',
  '42220': 'celo',
  '1284': 'moonbeam',
  '1285': 'moonriver',
};

const NON_EVM_CHAIN_ID_TO_INSTITUTION_CODE: Record<string, string> = {
  '0': 'bitcoin',
  '-2': 'solana',
  '-1': 'tron',
  '-15': 'ton',
};

function institutionCodeForChainId(chainId: string | number): string | null {
  const key = String(chainId);
  return EVM_CHAIN_ID_TO_INSTITUTION_CODE[key] ?? NON_EVM_CHAIN_ID_TO_INSTITUTION_CODE[key] ?? null;
}

/**
 * Synthetic `Token` baseCurrency for AddressValidatorProvider calls.
 * The validators don't actually consult the base currency — they
 * just need a valid `ProviderContext`. Built once at module load.
 */
const SYNTHETIC_USD_TOKEN: Token = {
  id: 'synthetic-usd',
  symbol: 'USD',
  name: 'United States Dollar',
  typeId: 'fiat',
  decimals: 2,
  iconUrl: null,
  providerMetadata: {},
  isScamProbability: 0,
  isActive: true,
  marketSegment: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function makeCtx(): ProviderContext {
  return { baseCurrency: SYNTHETIC_USD_TOKEN, timestamp: new Date() };
}

/**
 * Public chain config row. The cloud-client adapter consumes this
 * shape verbatim.
 */
interface ChainConfig {
  chainId: number | string;
  name: string;
  type: 'evm' | 'bitcoin' | 'solana' | 'tron' | 'ton';
  nativeSymbol: string;
  nativeName: string;
  isActive: boolean;
}

/**
 * Static chain catalog mirroring `WalletDiscoveryService` —
 * frontend-facing list of chains the data-provider can talk to.
 */
const CHAIN_CATALOG: ChainConfig[] = [
  {
    chainId: 1,
    name: 'Ethereum',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    isActive: true,
  },
  {
    chainId: 56,
    name: 'Binance Smart Chain',
    type: 'evm',
    nativeSymbol: 'BNB',
    nativeName: 'Binance Coin',
    isActive: true,
  },
  {
    chainId: 137,
    name: 'Polygon',
    type: 'evm',
    nativeSymbol: 'MATIC',
    nativeName: 'Polygon',
    isActive: true,
  },
  {
    chainId: 43114,
    name: 'Avalanche',
    type: 'evm',
    nativeSymbol: 'AVAX',
    nativeName: 'Avalanche',
    isActive: true,
  },
  {
    chainId: 42161,
    name: 'Arbitrum',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    isActive: true,
  },
  {
    chainId: 10,
    name: 'Optimism',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    isActive: true,
  },
  {
    chainId: 8453,
    name: 'Base',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    isActive: true,
  },
  {
    chainId: 250,
    name: 'Fantom',
    type: 'evm',
    nativeSymbol: 'FTM',
    nativeName: 'Fantom',
    isActive: true,
  },
  {
    chainId: 25,
    name: 'Cronos',
    type: 'evm',
    nativeSymbol: 'CRO',
    nativeName: 'Cronos',
    isActive: true,
  },
  {
    chainId: 42170,
    name: 'Arbitrum Nova',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    isActive: true,
  },
  {
    chainId: 324,
    name: 'zkSync Era',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    isActive: true,
  },
  {
    chainId: 534352,
    name: 'Scroll',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    isActive: true,
  },
  {
    chainId: 59144,
    name: 'Linea',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    isActive: true,
  },
  {
    chainId: 81457,
    name: 'Blast',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    isActive: true,
  },
  {
    chainId: 5000,
    name: 'Mantle',
    type: 'evm',
    nativeSymbol: 'MNT',
    nativeName: 'Mantle',
    isActive: true,
  },
  {
    chainId: 204,
    name: 'opBNB',
    type: 'evm',
    nativeSymbol: 'BNB',
    nativeName: 'Binance Coin',
    isActive: true,
  },
  {
    chainId: 100,
    name: 'Gnosis',
    type: 'evm',
    nativeSymbol: 'xDAI',
    nativeName: 'xDAI',
    isActive: true,
  },
  {
    chainId: 42220,
    name: 'Celo',
    type: 'evm',
    nativeSymbol: 'CELO',
    nativeName: 'Celo',
    isActive: true,
  },
  {
    chainId: 1284,
    name: 'Moonbeam',
    type: 'evm',
    nativeSymbol: 'GLMR',
    nativeName: 'Glimmer',
    isActive: true,
  },
  {
    chainId: 1285,
    name: 'Moonriver',
    type: 'evm',
    nativeSymbol: 'MOVR',
    nativeName: 'Moonriver',
    isActive: true,
  },
  {
    chainId: 0,
    name: 'Bitcoin',
    type: 'bitcoin',
    nativeSymbol: 'BTC',
    nativeName: 'Bitcoin',
    isActive: true,
  },
  {
    chainId: -2,
    name: 'Solana',
    type: 'solana',
    nativeSymbol: 'SOL',
    nativeName: 'Solana',
    isActive: true,
  },
  {
    chainId: -1,
    name: 'Tron',
    type: 'tron',
    nativeSymbol: 'TRX',
    nativeName: 'Tron',
    isActive: true,
  },
  {
    chainId: -15,
    name: 'TON',
    type: 'ton',
    nativeSymbol: 'TON',
    nativeName: 'Toncoin',
    isActive: true,
  },
];

const chainIdSchema = z.union([z.string(), z.number()]);

export const chainsRouter = router({
  /**
   * Returns every supported chain config. Backend uses this to seed
   * the address validators table without having to ship the chain
   * list in-process.
   */
  listConfigs: bearerProcedure.query((): ChainConfig[] => CHAIN_CATALOG),

  /**
   * Public-endpoint native + ERC-20 balance fetch. Returns the
   * `TokenBalance[]` shape consumed by `@scani/cloud-client`'s
   * `CloudChainService`. The BalanceProvider's `HoldingSnapshot[]`
   * is projected into that shape inline.
   */
  getTokenBalances: bearerProcedure
    .input(z.object({ chainId: chainIdSchema, address: z.string() }))
    .mutation(async ({ input }) => {
      const institutionCode = institutionCodeForChainId(input.chainId);
      if (!institutionCode) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Unsupported chainId: ${input.chainId}`,
        });
      }
      const provider = Container.get(ProviderRegistry).getBalanceFetcher(institutionCode);
      if (!provider) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `No registered balance provider for institutionCode '${institutionCode}'`,
        });
      }
      try {
        const ctx = {
          ...makeCtx(),
          institutionCode,
          credentialsRef: { userId: 'data-provider', institutionId: institutionCode },
          resolveCredentials: async () => ({ walletAddress: input.address }),
        };
        const snapshots = await provider.fetchBalances(ctx);
        // Project into TokenBalance shape — the cloud-client adapter
        // expects { symbol, name, balance, decimals, isNative,
        // tokenAddress }. We synthesize from `tokenIdentity`.
        return snapshots.map((s) => {
          const ti = s.tokenIdentity;
          const meta = ti.providerMetadata as
            | { etherscan?: { contractAddress?: string }; contractAddress?: string }
            | string
            | null
            | undefined;
          const contractAddress = (() => {
            if (!meta || typeof meta === 'string') return undefined;
            return meta.etherscan?.contractAddress ?? meta.contractAddress;
          })();
          return {
            symbol: ti.symbol ?? '',
            name: ti.name ?? ti.symbol ?? '',
            balance: s.balance,
            decimals: typeof ti.decimals === 'number' ? ti.decimals : 18,
            isNative: !contractAddress,
            tokenAddress: contractAddress ?? undefined,
            iconUrl: ti.iconUrl ?? undefined,
          };
        });
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
      const institutionCode = institutionCodeForChainId(input.chainId);
      if (!institutionCode) return false;
      const validator = Container.get(ProviderRegistry).getAddressValidator(institutionCode);
      if (!validator) return false;
      try {
        return await validator.hasActivity(input.address, institutionCode, makeCtx());
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
      const institutionCode = institutionCodeForChainId(input.chainId);
      if (!institutionCode) return null;
      const validator = Container.get(ProviderRegistry).getAddressValidator(institutionCode);
      if (!validator?.resolveAddressName) return null;
      try {
        return await validator.resolveAddressName(input.address, makeCtx());
      } catch {
        return null;
      }
    }),
});

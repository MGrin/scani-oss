/**
 * `WalletDiscoveryService` — domain-side façade over the
 * `@scani/providers` registry for the read-side discovery operations
 * the wallet/account import flows need:
 *
 *   - `detectWalletChains(address)` — probe every registered chain
 *      provider's `hasActivity` in parallel; return the institution
 *      codes the address has activity on.
 *   - `detectWalletInstitutions(address)` — same but resolves to
 *      Scani `institutionId`s via `institution_blockchain_mappings`.
 *      Used by `ImportWalletAddressUseCase`.
 *   - `resolveEnsName(address)` — Ethereum-mainnet ENS reverse lookup
 *      via the Etherscan provider's `AddressValidatorProvider.resolveAddressName`.
 *   - `getAllSupportedChains()` — UI-facing catalog of every chain
 *      Scani knows about. Inlined here so the registry doesn't have
 *      to expose chain metadata it otherwise doesn't need.
 */

import { db } from '@scani/db/connection';
import type { Token } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { ProviderRegistry } from '@scani/providers/core/registry';
import type { ProviderContext } from '@scani/providers/core/types';
import { eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { InstitutionBlockchainMappingRepository } from '../../repositories/InstitutionBlockchainMappingRepository';

/**
 * Public chain-config row. Wallet-import + UI consumers consume this
 * directly.
 */
export interface SupportedChain {
  /** Chain ID (EIP-155 for EVM chains; arbitrary negative ints for
      non-EVM chains — the same convention as the
      `institution_blockchain_mappings` table). */
  chainId: number | string;
  /** Human-readable chain name. */
  name: string;
  /** Chain type. */
  type: 'evm' | 'bitcoin' | 'solana' | 'tron' | 'ton';
  /** Native token symbol. */
  nativeSymbol: string;
  /** Native token name. */
  nativeName: string;
  /** Etherscan V2 API base URL (EVM only). */
  explorerApiUrl?: string;
  /** Whether chain is active (always true here — only active rows
      are emitted). */
  isActive: boolean;
}

/**
 * Static EVM chain catalog for the UI's "list of supported chains".
 * The Etherscan provider has its own internal catalog at
 * `packages/clients/providers/src/providers/etherscan/chains.ts`;
 * this one is the public/UI surface — keep them in sync when
 * adding a new chain.
 */
const EVM_CHAINS: SupportedChain[] = [
  {
    chainId: 1,
    name: 'Ethereum',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },
  {
    chainId: 56,
    name: 'Binance Smart Chain',
    type: 'evm',
    nativeSymbol: 'BNB',
    nativeName: 'Binance Coin',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },
  {
    chainId: 137,
    name: 'Polygon',
    type: 'evm',
    nativeSymbol: 'MATIC',
    nativeName: 'Polygon',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },
  {
    chainId: 43114,
    name: 'Avalanche',
    type: 'evm',
    nativeSymbol: 'AVAX',
    nativeName: 'Avalanche',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },
  {
    chainId: 42161,
    name: 'Arbitrum',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },
  {
    chainId: 10,
    name: 'Optimism',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },
  {
    chainId: 8453,
    name: 'Base',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },
  {
    chainId: 250,
    name: 'Fantom',
    type: 'evm',
    nativeSymbol: 'FTM',
    nativeName: 'Fantom',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },
  {
    chainId: 25,
    name: 'Cronos',
    type: 'evm',
    nativeSymbol: 'CRO',
    nativeName: 'Cronos',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },
  {
    chainId: 42170,
    name: 'Arbitrum Nova',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },
  {
    chainId: 324,
    name: 'zkSync Era',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },
  {
    chainId: 534352,
    name: 'Scroll',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },
  {
    chainId: 59144,
    name: 'Linea',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },
  {
    chainId: 81457,
    name: 'Blast',
    type: 'evm',
    nativeSymbol: 'ETH',
    nativeName: 'Ethereum',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },
  {
    chainId: 5000,
    name: 'Mantle',
    type: 'evm',
    nativeSymbol: 'MNT',
    nativeName: 'Mantle',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },
  {
    chainId: 204,
    name: 'opBNB',
    type: 'evm',
    nativeSymbol: 'BNB',
    nativeName: 'Binance Coin',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },
  {
    chainId: 100,
    name: 'Gnosis',
    type: 'evm',
    nativeSymbol: 'xDAI',
    nativeName: 'xDAI',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },
  {
    chainId: 42220,
    name: 'Celo',
    type: 'evm',
    nativeSymbol: 'CELO',
    nativeName: 'Celo',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },
  {
    chainId: 1284,
    name: 'Moonbeam',
    type: 'evm',
    nativeSymbol: 'GLMR',
    nativeName: 'Glimmer',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },
  {
    chainId: 1285,
    name: 'Moonriver',
    type: 'evm',
    nativeSymbol: 'MOVR',
    nativeName: 'Moonriver',
    explorerApiUrl: 'https://api.etherscan.io/v2/api',
    isActive: true,
  },
];

/**
 * Non-EVM chain catalog. Uses negative-int chainId values to share
 * the chainId column with EVM (which uses EIP-155 positive ints).
 */
const NON_EVM_CHAINS: SupportedChain[] = [
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

/**
 * Mapping from EVM chainId → institutionCode (matches the
 * `etherscan/chains.ts` catalog). Non-EVM chains use the type as
 * their institutionCode.
 */
const EVM_CHAIN_ID_TO_INSTITUTION_CODE: Record<number, string> = {
  1: 'ethereum',
  56: 'bsc',
  137: 'polygon',
  43114: 'avalanche',
  42161: 'arbitrum',
  10: 'optimism',
  8453: 'base',
  250: 'fantom',
  25: 'cronos',
  42170: 'arbitrum-nova',
  324: 'zksync-era',
  534352: 'scroll',
  59144: 'linea',
  81457: 'blast',
  5000: 'mantle',
  204: 'opbnb',
  100: 'gnosis',
  42220: 'celo',
  1284: 'moonbeam',
  1285: 'moonriver',
};

const NON_EVM_CHAIN_ID_TO_INSTITUTION_CODE: Record<string, string> = {
  '0': 'bitcoin',
  '-2': 'solana',
  '-1': 'tron',
  '-15': 'ton',
};

/**
 * Synthetic `Token` row used as the `baseCurrency` for hasActivity
 * probes. The address validators don't actually consult the base
 * currency — they just need a valid `ProviderContext`. Built once
 * at module load.
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

@Service()
export class WalletDiscoveryService {
  private readonly logger = createComponentLogger('service:WalletDiscoveryService');

  // Class-field DI per the project's typedi conventions.
  private readonly mappingRepo = Container.get(InstitutionBlockchainMappingRepository);

  /**
   * Surface the registry per call rather than caching at construction
   * time so test seeders that swap the registry between tests pick up
   * the new instance.
   */
  private get registry(): ProviderRegistry {
    return Container.get(ProviderRegistry);
  }

  /**
   * Translate a DB institution UUID into the static `institutionCode`
   * that the new `@scani/providers` registry dispatches by.
   *
   * Three resolution paths in order:
   *   1. Blockchain mapping (`institution_blockchain_mappings`):
   *      `institutionId` → `chainId` → static institutionCode (one of
   *      'ethereum', 'bsc', 'bitcoin', 'solana', …). Covers every
   *      wallet-import flow.
   *   2. Institution name fallback: lookup `institutions.name` and
   *      lowercase-normalize ('Binance' → 'binance'). Covers every CEX
   *      since the new providers all use lowercase-name codes.
   *   3. Pass-through: if the caller already passed a recognized code
   *      (e.g. 'binance') instead of a UUID, just return it. Use cases
   *      pass either form, so we accept both.
   *
   * Returns null when nothing matches — caller should treat as
   * "unknown institution" and skip.
   */
  async resolveInstitutionCode(institutionIdOrCode: string): Promise<string | null> {
    // Path 3 first (cheapest): if it looks like a code already, see if
    // any provider claims it. UUID format is 8-4-4-4-12 hex; anything
    // shorter or non-hex is almost certainly a static code.
    const looksLikeUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      institutionIdOrCode
    );
    if (!looksLikeUuid) {
      // Trust the caller — the new registry's per-provider
      // `canFetchBalances` filter rejects unknown codes anyway.
      return institutionIdOrCode;
    }

    // Path 1: blockchain mapping.
    try {
      const mapping = await this.mappingRepo.findByInstitutionId(institutionIdOrCode);
      if (mapping?.isActive) {
        const chainIdStr = String(mapping.chainId);
        const evmCode = EVM_CHAIN_ID_TO_INSTITUTION_CODE[Number(chainIdStr)];
        if (evmCode) return evmCode;
        const nonEvmCode = NON_EVM_CHAIN_ID_TO_INSTITUTION_CODE[chainIdStr];
        if (nonEvmCode) return nonEvmCode;
      }
    } catch (err) {
      this.logger.debug(
        { institutionId: institutionIdOrCode, error: err },
        'Blockchain mapping lookup failed; falling through to institution-name fallback'
      );
    }

    // Path 2: institution name fallback.
    try {
      const [institution] = await db
        .select({ name: schema.institutions.name })
        .from(schema.institutions)
        .where(eq(schema.institutions.id, institutionIdOrCode))
        .limit(1);
      if (institution?.name) {
        const name = institution.name.trim();
        // 2a: exact match against a registered manifest's institutionName.
        // Covers names that don't normalize to the provider's canonical
        // code — e.g. 'Interactive Brokers' → 'ibkr' (NOT 'interactivebrokers').
        const lowerName = name.toLowerCase();
        const manifest = this.registry
          .listIntegrationManifests()
          .find((m) => m.institutionName.toLowerCase() === lowerName);
        if (manifest) return manifest.providerKey;
        // 2b: lossy lowercase + strip-non-alphanumeric fallback. Works for
        // one-word CEX names ('Binance' → 'binance', 'Kraken' → 'kraken').
        return name.toLowerCase().replace(/[^a-z0-9]/g, '');
      }
    } catch (err) {
      this.logger.debug(
        { institutionId: institutionIdOrCode, error: err },
        'Institution name lookup failed'
      );
    }

    return null;
  }

  /**
   * Catalog of every chain Scani knows about. Used by the wallet UI
   * to populate the "supported chains" picker. Inlined here because
   * the registry deliberately doesn't carry chain metadata — it
   * dispatches by `institutionCode` and chain configs live with the
   * provider that uses them.
   */
  getAllSupportedChains(): SupportedChain[] {
    return [...EVM_CHAINS, ...NON_EVM_CHAINS];
  }

  /**
   * Reverse-resolve an Ethereum address (or any name) to an ENS
   * label. Routes via the registered `AddressValidatorProvider` for
   * the `ethereum` institution code (the Etherscan provider). Returns
   * null when ENS is unsupported, the address has no name, or the
   * RPC call fails.
   */
  async resolveEnsName(address: string): Promise<string | null> {
    const validator = this.registry.getAddressValidator('ethereum');
    if (!validator?.resolveAddressName) return null;
    try {
      return await validator.resolveAddressName(address, this.makeContext());
    } catch (err) {
      this.logger.debug(
        { address: `${address.substring(0, 10)}...`, error: err },
        'ENS resolution threw; returning null'
      );
      return null;
    }
  }

  /**
   * Probe every registered chain validator in parallel and return the
   * institution codes the address has activity on. Order is
   * registration order (priority).
   */
  async detectWalletChains(address: string): Promise<string[]> {
    const validators = this.registry.getAllAddressValidators();
    const startTime = Date.now();

    this.logger.info(
      {
        address: `${address.substring(0, 10)}...`,
        validatorCount: validators.length,
      },
      'Starting wallet chain detection'
    );

    const ctx = this.makeContext();

    // Each validator covers one or more institution codes. For EVM
    // we ask once per EVM institution code (the Etherscan provider's
    // `canValidate` returns true for any of them); for chain-specific
    // providers (bitcoin, solana, tron, ton) we ask once with the
    // matching institution code.
    const candidates: Array<{ institutionCode: string }> = [
      ...EVM_CHAINS.map((c) => ({
        institutionCode: EVM_CHAIN_ID_TO_INSTITUTION_CODE[c.chainId as number] ?? '',
      })).filter((c) => c.institutionCode),
      ...NON_EVM_CHAINS.map((c) => ({
        institutionCode: NON_EVM_CHAIN_ID_TO_INSTITUTION_CODE[String(c.chainId)] ?? '',
      })).filter((c) => c.institutionCode),
    ];

    const checks = candidates.map(async ({ institutionCode }) => {
      const validator = this.registry.getAddressValidator(institutionCode);
      if (!validator) return null;
      if (!validator.isValidAddress(address, institutionCode)) return null;
      try {
        const ok = await validator.hasActivity(address, institutionCode, ctx);
        return ok ? institutionCode : null;
      } catch (err) {
        this.logger.debug(
          {
            institutionCode,
            address: `${address.substring(0, 10)}...`,
            error: err instanceof Error ? err.message : String(err),
          },
          'hasActivity threw; treating as no activity'
        );
        return null;
      }
    });

    const results = await Promise.all(checks);
    const detected = results.filter((c): c is string => c !== null);

    this.logger.info(
      {
        address: `${address.substring(0, 10)}...`,
        detected,
        totalDuration: `${Date.now() - startTime}ms`,
      },
      `Wallet chain detection completed (found on ${detected.length} chains)`
    );

    return detected;
  }

  /**
   * Detect chains AND translate to Scani `institutionId`s via the
   * `institution_blockchain_mappings` table. Returns the DB UUIDs
   * (institutionIds), not the static codes — use cases pass these
   * straight to the holding write path.
   *
   * The mapping table is keyed on `chainId` (string): EVM institution
   * codes map back to their EIP-155 chainId; non-EVM uses the
   * negative-int convention.
   */
  async detectWalletInstitutions(address: string): Promise<string[]> {
    const institutionCodes = await this.detectWalletChains(address);
    const institutionIds: string[] = [];
    for (const code of institutionCodes) {
      const chainIdStr = INSTITUTION_CODE_TO_CHAIN_ID[code];
      if (!chainIdStr) continue;
      const mapping = await this.mappingRepo.findByChainId(chainIdStr);
      if (mapping?.isActive) institutionIds.push(mapping.institutionId);
    }
    return institutionIds;
  }

  private makeContext(): ProviderContext {
    return {
      baseCurrency: SYNTHETIC_USD_TOKEN,
      timestamp: new Date(),
    };
  }
}

/**
 * Reverse map: institutionCode → chainId string. Built from the
 * forward maps so a single source of truth. The mapping table in
 * `institution_blockchain_mappings` uses string-encoded chainIds.
 */
const INSTITUTION_CODE_TO_CHAIN_ID: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [chainId, code] of Object.entries(EVM_CHAIN_ID_TO_INSTITUTION_CODE)) {
    out[code] = chainId;
  }
  for (const [chainId, code] of Object.entries(NON_EVM_CHAIN_ID_TO_INSTITUTION_CODE)) {
    out[code] = chainId;
  }
  return out;
})();

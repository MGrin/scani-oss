/**
 * IntegrationManager
 *
 * Manages all institution integrations and provides unified access to them.
 * Uses a registry-based architecture to support all integration types:
 * - Blockchains (Ethereum, Bitcoin, Solana, etc.)
 * - Exchanges (Binance, Kraken, Coinbase, etc.)
 * - Brokers, Banks, Payment providers, and more
 *
 * This manager:
 * - Creates integrations on-demand using the integration registry
 * - Provides lookup by institution ID
 * - Maintains database-backed chain-to-institution mappings for backwards compatibility
 * - Manages global rate limiters
 * - Integrates with TypeDI for dependency injection
 */

import type { CloudClient } from '@scani/cloud-client';
import { CloudChainService } from '@scani/cloud-client/adapters/chains';
import { getCloudClient } from '@scani/cloud-client/runtime';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { config as pricingConfig } from '@scani/pricing-providers';
import { RateLimiter } from '@scani/rate-limiter';
import { eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import type { ScaniIntegration } from './base';
import type { ChainConfig, IBlockchainService } from './blockchain-services';
import {
  BitcoinChainService,
  EVM_CHAINS,
  EvmChainService,
  getAllChains,
  getChainConfig,
  NON_EVM_CHAINS,
  SolanaChainService,
  TonChainService,
  TronChainService,
} from './blockchain-services';
import { CHAIN_MAPPING_PROVIDER, type IChainMappingProvider } from './chain-mapping-provider';
import { allIntegrationConfigs } from './config/integrationConfigs';
import {
  BitcoinIntegration,
  EvmChainIntegration,
  SolanaIntegration,
  TonIntegration,
  TronIntegration,
} from './implementations';
import { integrationRegistry } from './registry/IntegrationRegistry';

const logger = createComponentLogger('integration-manager');

/**
 * Global rate limiters for all APIs
 * Shared across all integrations to prevent exceeding provider limits
 */
// Every limiter passes a stable namespace so `initializeRateLimiterRedis`
// (called at backend/worker boot) can route the bucket through Redis —
// without that, N workers each running a local 7rps limiter would blow
// past Etherscan's provider-side budget N×.
const GLOBAL_INTEGRATION_RATE_LIMITERS = {
  // Etherscan: 7 calls/second paid plan
  etherscan: new RateLimiter(7, 1000, { namespace: 'etherscan' }),
  // Bitcoin blockchain.info: ~1 call/10 seconds to be safe
  bitcoin: new RateLimiter(1, 10000, { namespace: 'bitcoin' }),
  // Solana public RPC: ~10 calls/second
  solana: new RateLimiter(10, 1000, { namespace: 'solana' }),
  // Tron TronGrid: ~20 calls/second free tier
  tron: new RateLimiter(20, 1000, { namespace: 'tron' }),
  // TON toncenter: ~1 call/second free tier
  ton: new RateLimiter(1, 1000, { namespace: 'ton' }),
  // Binance global (per-provider budget): ~10 calls/second conservative
  binance: new RateLimiter(10, 1000, { namespace: 'binance-global' }),
};

/**
 * Factory registry keyed on chain type. Adding a new chain family becomes
 * a one-liner entry here instead of another `case` sprinkled across the
 * manager — Open/Closed in the "registry" shape rather than a growing
 * switch. The individual factories keep their existing rate-limiter
 * wiring; they just live in one table now.
 */
type BlockchainFactory = (institutionId: string, chainConfig: ChainConfig) => ScaniIntegration;

const BLOCKCHAIN_FACTORIES: Record<string, BlockchainFactory> = {
  evm: (institutionId, chainConfig) =>
    new EvmChainIntegration(
      institutionId,
      chainConfig,
      process.env.ETHERSCAN_API_KEY || '',
      GLOBAL_INTEGRATION_RATE_LIMITERS.etherscan,
      undefined,
      undefined
    ),
  bitcoin: (institutionId, chainConfig) =>
    new BitcoinIntegration(
      institutionId,
      chainConfig,
      GLOBAL_INTEGRATION_RATE_LIMITERS.bitcoin,
      undefined,
      undefined
    ),
  solana: (institutionId, chainConfig) =>
    new SolanaIntegration(
      institutionId,
      chainConfig,
      GLOBAL_INTEGRATION_RATE_LIMITERS.solana,
      undefined,
      undefined
    ),
  tron: (institutionId, chainConfig) =>
    new TronIntegration(
      institutionId,
      chainConfig,
      GLOBAL_INTEGRATION_RATE_LIMITERS.tron,
      undefined,
      undefined
    ),
  ton: (institutionId, chainConfig) =>
    new TonIntegration(
      institutionId,
      chainConfig,
      GLOBAL_INTEGRATION_RATE_LIMITERS.ton,
      undefined,
      undefined
    ),
};

function createBlockchainIntegrationFactory(
  institutionId: string,
  chainConfig: ChainConfig,
  chainType: string
): (() => ScaniIntegration) | null {
  const factory = BLOCKCHAIN_FACTORIES[chainType];
  if (!factory) return null;
  return () => factory(institutionId, chainConfig);
}

/**
 * Initialize the integration registry
 * This happens once at startup and registers all available integrations
 * (exchanges AND blockchains) so the registry is the single source of truth.
 */
async function initializeIntegrationRegistry(): Promise<void> {
  if (integrationRegistry.size() > 0) {
    logger.debug('Integration registry already initialized');
    return;
  }

  logger.debug('Initializing integration registry with all configurations');

  // First, register all exchange integrations with their static IDs
  allIntegrationConfigs.forEach((config) => {
    integrationRegistry.register(config);
  });

  // Then, dynamically register exchange integrations with their database UUIDs
  try {
    const knownExchanges = allIntegrationConfigs.map((config) => config.name);

    for (const exchangeName of knownExchanges) {
      const [institution] = await db
        .select()
        .from(schema.institutions)
        .where(eq(schema.institutions.name, exchangeName))
        .limit(1);

      if (institution) {
        const staticConfig = allIntegrationConfigs.find((config) => config.name === exchangeName);

        if (staticConfig) {
          integrationRegistry.register({
            ...staticConfig,
            institutionId: institution.id,
          });
          logger.debug(
            {
              exchangeName,
              staticId: staticConfig.institutionId,
              dbId: institution.id,
            },
            'Registered exchange with database UUID'
          );
        }
      }
    }
  } catch (error) {
    logger.warn(
      { error },
      'Failed to register exchanges with database UUIDs - will fall back to static IDs'
    );
  }

  // Register blockchain integrations from DB mappings so the registry
  // is the single source of truth (no more fallback to InstitutionBlockchainMappingRepository)
  try {
    const mappings = await db
      .select()
      .from(schema.institutionBlockchainMappings)
      .where(eq(schema.institutionBlockchainMappings.isActive, true));

    let registered = 0;
    for (const mapping of mappings) {
      const chainConfig = getChainConfig(mapping.chainId);
      if (!chainConfig) continue;

      const factory = createBlockchainIntegrationFactory(
        mapping.institutionId,
        chainConfig,
        mapping.chainType
      );
      if (!factory) continue;

      integrationRegistry.register({
        institutionId: mapping.institutionId,
        name: chainConfig.name,
        type: 'blockchain',
        authType: 'rpc',
        createIntegration: factory,
      });
      registered++;
    }

    logger.info(
      { blockchainCount: registered, exchangeCount: allIntegrationConfigs.length },
      'Integration registry initialized'
    );
  } catch (error) {
    logger.warn(
      { error },
      'Failed to register blockchain integrations - will fall back to DB mappings'
    );
  }
}

/**
 * IntegrationManager Service
 * Manages all institution integrations using a registry-based architecture
 */
@Service()
export class IntegrationManager {
  private readonly integrationCache = new Map<string, ScaniIntegration>();
  /**
   * Resolve the chain-mapping provider **on every call** rather than at
   * field-init time.
   *
   * Why: `@scani/domain/repositories` registers the binding via a module
   * side-effect (`Container.set(CHAIN_MAPPING_PROVIDER, ...)`). TypeDI
   * instantiates this class eagerly on the first `Container.get(IntegrationManager)`,
   * which can fire BEFORE the domain barrel has been imported for the
   * first time — e.g. when the worker resolves `IntegrationManager`
   * while bootstrapping a processor, and `@scani/domain/repositories`
   * only gets pulled in later via a different import chain. A field
   * initializer would then latch onto the no-op stub for the process
   * lifetime and `detectWalletInstitutions` would silently return [].
   * The getter defers the lookup until the call site, so any
   * registration that has happened by then takes effect.
   *
   * Hot-path cost is negligible (`Container.has` + `Container.get` are
   * Map lookups); this runs at most a few times per wallet-import job.
   */
  private get mappingRepository(): IChainMappingProvider {
    if (Container.has(CHAIN_MAPPING_PROVIDER)) {
      return Container.get<IChainMappingProvider>(CHAIN_MAPPING_PROVIDER);
    }
    return {
      findByChainId: async () => null,
      findByInstitutionId: async () => null,
      findAllActive: async () => [],
    };
  }
  /**
   * Raw per-chain blockchain clients, keyed by chainId. Populated in the
   * constructor — no async init, no DB dependency. Used by chain detection
   * and ENS resolution which need to iterate over "every chain we know
   * about" without round-tripping to the DB for the mapping table.
   *
   * Consolidated under IntegrationManager so there's a single public
   * facade over "integrations + blockchain chains".
   */
  private readonly blockchainServices = new Map<string | number, IBlockchainService>();
  private initialized = false;
  private readonly cloudClient: CloudClient | null;

  constructor() {
    // Cloud routing: when SCANI_CLOUD_URL + SCANI_CLOUD_API_KEY are set
    // every async blockchain call hops through the data-provider via
    // CloudChainService. Local chain services still handle address
    // validation + chain metadata (they're cheap, sync, and don't need
    // upstream creds). Resolution lives in @scani/cloud-client/runtime
    // so tests can swap the client via `setCloudClient(stub)` without
    // mutating process.env.
    this.cloudClient = getCloudClient();

    this.initializeBlockchainServices();
  }

  /** Wrap an inner chain service in CloudChainService when running in cloud mode. */
  private maybeWrap(inner: IBlockchainService): IBlockchainService {
    if (!this.cloudClient) return inner;
    return new CloudChainService({ inner, client: this.cloudClient });
  }

  /**
   * Initialize the manager (called once at startup). Lazy — only needed for
   * the registry that powers `getIntegration(institutionId)`; blockchain
   * chain detection + ENS resolution work without it.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await initializeIntegrationRegistry();
    this.initialized = true;
  }

  /**
   * Stand up the per-chain IBlockchainService instances. Called once in
   * the constructor — no async init, no DB dependency. Chain detection
   * and ENS resolution depend on these services.
   */
  private initializeBlockchainServices(): void {
    // EVM chains — all share the unified Etherscan V2 endpoint + key.
    const etherscanLimiter = GLOBAL_INTEGRATION_RATE_LIMITERS.etherscan;
    for (const [key, chainConfig] of Object.entries(EVM_CHAINS)) {
      if (chainConfig.isActive && chainConfig.explorerApiUrl) {
        const service = new EvmChainService(chainConfig, {
          apiKey: pricingConfig.etherscan.apiKey,
          rateLimiter: etherscanLimiter,
        });
        this.blockchainServices.set(chainConfig.chainId, this.maybeWrap(service));
        logger.debug({ chain: key, chainId: chainConfig.chainId }, 'Initialized EVM chain service');
      }
    }

    const bitcoinChain = NON_EVM_CHAINS.bitcoin;
    if (bitcoinChain?.isActive) {
      this.blockchainServices.set(
        bitcoinChain.chainId,
        this.maybeWrap(
          new BitcoinChainService(bitcoinChain, {
            rateLimiter: GLOBAL_INTEGRATION_RATE_LIMITERS.bitcoin,
          })
        )
      );
    }

    const solanaChain = NON_EVM_CHAINS.solana;
    if (solanaChain?.isActive) {
      this.blockchainServices.set(
        solanaChain.chainId,
        this.maybeWrap(
          new SolanaChainService(solanaChain, {
            rateLimiter: GLOBAL_INTEGRATION_RATE_LIMITERS.solana,
          })
        )
      );
    }

    const tronChain = NON_EVM_CHAINS.tron;
    if (tronChain?.isActive) {
      this.blockchainServices.set(
        tronChain.chainId,
        this.maybeWrap(
          new TronChainService(tronChain, {
            rateLimiter: GLOBAL_INTEGRATION_RATE_LIMITERS.tron,
          })
        )
      );
    }

    const tonChain = NON_EVM_CHAINS.ton;
    if (tonChain?.isActive) {
      this.blockchainServices.set(
        tonChain.chainId,
        this.maybeWrap(
          new TonChainService(tonChain, {
            rateLimiter: GLOBAL_INTEGRATION_RATE_LIMITERS.ton,
          })
        )
      );
    }

    logger.info({ totalChains: this.blockchainServices.size }, 'Blockchain services initialized');
  }

  /** Raw per-chain service accessor (balance fetching, address validation). */
  getBlockchainService(chainId: string | number): IBlockchainService | undefined {
    return this.blockchainServices.get(chainId);
  }

  /** List all chainIds we have an initialized client for. */
  getActiveChainIds(): Array<string | number> {
    return Array.from(this.blockchainServices.keys());
  }

  /** All supported chain configs, for UI pickers. */
  getAllSupportedChains(): ChainConfig[] {
    return getAllChains();
  }

  /**
   * ENS resolution (Ethereum mainnet only). Null on non-Ethereum addresses
   * or unresolvable names — never throws.
   */
  async resolveEnsName(address: string): Promise<string | null> {
    const ethereum = this.blockchainServices.get(1);
    if (!ethereum?.resolveAddressName) return null;
    try {
      return await ethereum.resolveAddressName(address);
    } catch {
      return null;
    }
  }

  /**
   * Detect which chains a wallet has any activity on. Runs
   * `IBlockchainService.hasActivity()` across every initialized chain in
   * parallel. Single code path — no registry dependency, no pre-init
   * needed. The sync `wallet.detectChains` tRPC endpoint and the async
   * `ImportWalletAddressUseCase` both call this.
   *
   * Returns chain IDs. Callers that need institution IDs should use
   * `detectWalletInstitutions(...)` instead, which translates via the
   * mapping repo.
   */
  async detectWalletChains(address: string): Promise<Array<string | number>> {
    const detected: Array<string | number> = [];
    const startTime = Date.now();

    logger.info(
      {
        address: `${address.substring(0, 10)}...`,
        totalChainsToCheck: this.blockchainServices.size,
      },
      'Starting wallet chain detection'
    );

    const checks = Array.from(this.blockchainServices.entries()).map(async ([chainId, service]) => {
      const chainStart = Date.now();
      try {
        if (!service.isValidAddress(address)) return null;
        if (service.hasActivity) {
          const has = await service.hasActivity(address);
          if (!has) return null;
        } else {
          const balances = await service.getTokenBalances(address);
          if (balances.length === 0) return null;
        }
        logger.debug(
          {
            chainId,
            chainName: service.getChainName(),
            duration: `${Date.now() - chainStart}ms`,
          },
          `Wallet detected on ${service.getChainName()}`
        );
        return chainId;
      } catch (error) {
        logger.debug(
          {
            chainId,
            chainName: service.getChainName(),
            duration: `${Date.now() - chainStart}ms`,
            error: error instanceof Error ? error.message : String(error),
          },
          `Wallet not detected on ${service.getChainName()}`
        );
        return null;
      }
    });

    const results = await Promise.all(checks);
    for (const chainId of results) {
      if (chainId !== null) detected.push(chainId);
    }

    logger.info(
      {
        address: `${address.substring(0, 10)}...`,
        detectedChains: detected.length,
        totalChecked: this.blockchainServices.size,
        totalDuration: `${Date.now() - startTime}ms`,
      },
      `Wallet chain detection completed in ${Date.now() - startTime}ms (found on ${detected.length} chains)`
    );

    return detected;
  }

  /**
   * Convenience: detect chains AND translate to institution IDs via the
   * DB mapping table. Used by `ImportWalletAddressUseCase` where the
   * downstream flow keys off institutionIds.
   */
  async detectWalletInstitutions(address: string): Promise<string[]> {
    const chainIds = await this.detectWalletChains(address);
    const institutionIds: string[] = [];
    for (const chainId of chainIds) {
      const mapping = await this.mappingRepository.findByChainId(String(chainId));
      if (mapping?.isActive) {
        institutionIds.push(mapping.institutionId);
      }
    }
    return institutionIds;
  }

  /**
   * Get integration by institution ID
   * First tries the registry (supports all integration types),
   * then falls back to database mappings for backwards compatibility with blockchains
   */
  async getIntegration(institutionId: string): Promise<ScaniIntegration | undefined> {
    // Ensure registry is initialized
    await this.initialize();

    // Check cache first
    if (this.integrationCache.has(institutionId)) {
      return this.integrationCache.get(institutionId);
    }

    // Try to create from registry (supports all integration types)
    const integration = integrationRegistry.createIntegration(institutionId);

    if (integration) {
      this.integrationCache.set(institutionId, integration);
      return integration;
    }

    // Fall back to database mappings for backwards compatibility with blockchains
    // This supports legacy chain-based integrations
    const mapping = await this.mappingRepository.findByInstitutionId(institutionId);

    if (!mapping?.isActive) {
      return undefined;
    }

    // Get chain configuration
    const chainConfig = getChainConfig(mapping.chainId);
    if (!chainConfig) {
      return undefined;
    }

    // Create blockchain integration from chain config
    const blockchainIntegration = this.createBlockchainIntegration(
      institutionId,
      chainConfig,
      mapping.chainType
    );

    if (blockchainIntegration) {
      this.integrationCache.set(institutionId, blockchainIntegration);
      return blockchainIntegration;
    }

    return undefined;
  }

  /**
   * Create a blockchain integration instance. Legacy fallback path used
   * by `getIntegration(institutionId)` when the registry hasn't yet
   * picked up the mapping. Delegates to the same `BLOCKCHAIN_FACTORIES`
   * registry the primary factory uses — same table, no duplicate switch.
   */
  private createBlockchainIntegration(
    institutionId: string,
    chainConfig: ChainConfig,
    chainType: string
  ): ScaniIntegration | undefined {
    const factory = BLOCKCHAIN_FACTORIES[chainType];
    return factory ? factory(institutionId, chainConfig) : undefined;
  }

  /**
   * Get all active institution IDs that have integrations
   * Uses database query instead of loading all into memory
   */
  async getActiveInstitutionIds(): Promise<string[]> {
    const mappings = await this.mappingRepository.findAllActive();
    return mappings.map((m) => m.institutionId);
  }

  /**
   * Check if an institution has an integration available
   */
  async hasIntegration(institutionId: string): Promise<boolean> {
    const mapping = await this.mappingRepository.findByInstitutionId(institutionId);
    return mapping?.isActive ?? false;
  }

  /**
   * Get the chain ID for an institution
   */
  async getChainIdForInstitution(institutionId: string): Promise<string | undefined> {
    const mapping = await this.mappingRepository.findByInstitutionId(institutionId);
    return mapping?.chainId;
  }

  /**
   * Clear integration cache (useful for testing or when mappings change)
   */
  clearCache(): void {
    this.integrationCache.clear();
  }
}

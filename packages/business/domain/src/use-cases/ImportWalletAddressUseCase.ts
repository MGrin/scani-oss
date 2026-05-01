/**
 * ImportWalletAddressUseCase
 *
 * Detects which chains a wallet address has activity on, then delegates the
 * per-chain account + holdings work to `IntegrationImportService` and the
 * post-import price warm-up to `PriceWarmupService`.
 */

import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { ProviderRegistry } from '@scani/providers/core/registry';
import type { HoldingSnapshot } from '@scani/providers/core/types';
import { and, eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { makeProviderContext } from '../lib/provider-context';
import { InstitutionBlockchainMappingRepository } from '../repositories/InstitutionBlockchainMappingRepository';
import {
  type DiscoveredAccountInfo,
  IntegrationCredentialsService,
  IntegrationImportService,
  type IntegrationImportTarget,
  PriceWarmupService,
  UserWalletService,
  WalletDiscoveryService,
} from '../services';

const logger = createComponentLogger('use-case:import-wallet');

export interface ImportWalletInput {
  address: string;
  displayName?: string;
  detectedInstitutionIds?: string[];
}

/**
 * Wire shape of one chain's worth of pre-fetched balance snapshots
 * stored on `user_jobs.result` between the worker's
 * `prepareReview` step and the `confirmFromReview` mutation. JSON-safe:
 * `capturedAt` is an ISO string, all metadata is plain JSON.
 */
export interface WalletReviewChain {
  institutionId: string;
  institutionName: string;
  institutionCode: string;
  chainId: string;
  accountName: string;
  preExistingAccountId?: string;
  snapshots: Array<{
    externalId: string;
    balance: string;
    capturedAt: string;
    tokenIdentity: {
      symbol?: string;
      name?: string;
      decimals?: number;
      iconUrl?: string | null;
      // biome-ignore lint/suspicious/noExplicitAny: jsonb providerMetadata is opaque to this layer
      providerMetadata?: any;
    };
  }>;
}

export interface PrepareWalletReviewResult {
  walletLabel: string;
  walletId: string;
  userBaseCurrencyId: string | null;
  cryptoTokenTypeId: string;
  walletAccountTypeId: string;
  chains: WalletReviewChain[];
  chainsDetected: number;
  errors: ImportWalletResult['errors'];
}

export interface ImportWalletResult {
  walletLabel: string;
  accounts: Array<{
    id: string;
    name: string;
    chainId: string | number;
    chainName: string;
    institutionId: string;
    institutionName: string;
  }>;
  holdings: Array<{
    id: string;
    accountId: string;
    accountName: string;
    chainName: string;
    tokenId: string;
    tokenSymbol: string;
    tokenName: string;
    tokenIconUrl: string | null;
    tokenIsNew: boolean;
    tokenScamProbability: number;
    balance: string;
    priceInBaseCurrency: string | null;
  }>;
  chainsDetected: number;
  tokensImported: number;
  errors: Array<{
    chainId: string | number;
    chainName: string;
    error: string;
  }>;
}

interface PreparedChain {
  institution: typeof schema.institutions.$inferSelect;
  institutionCode: string;
  chainId: string;
  snapshots: HoldingSnapshot[];
  preExistingAccountId?: string;
  accountName: string;
}

@Service()
export class ImportWalletAddressUseCase {
  constructor(
    private readonly walletDiscovery: WalletDiscoveryService = Container.get(
      WalletDiscoveryService
    ),
    private readonly userWalletService: UserWalletService = Container.get(UserWalletService),
    private readonly integrationCredentialsService: IntegrationCredentialsService = Container.get(
      IntegrationCredentialsService
    ),
    private readonly mappingRepository: InstitutionBlockchainMappingRepository = Container.get(
      InstitutionBlockchainMappingRepository
    ),
    private readonly integrationImportService: IntegrationImportService = Container.get(
      IntegrationImportService
    ),
    private readonly priceWarmupService: PriceWarmupService = Container.get(PriceWarmupService)
  ) {}

  async execute(input: ImportWalletInput, userId: string): Promise<ImportWalletResult> {
    logger.info(
      { userId, address: `${input.address.substring(0, 10)}...` },
      'Starting wallet import'
    );

    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (!user) throw new Error('User not found');

    const detectedInstitutionIds = await this.resolveDetectedInstitutionIds(input, userId);
    if (detectedInstitutionIds.length === 0) {
      return {
        walletLabel: this.computeWalletLabel(input.displayName, input.address),
        accounts: [],
        holdings: [],
        chainsDetected: 0,
        tokensImported: 0,
        errors: [],
      };
    }

    const userWallet = await this.upsertUserWallet(input, userId, detectedInstitutionIds);

    const [walletAccountType] = await db
      .select()
      .from(schema.accountTypes)
      .where(eq(schema.accountTypes.code, 'crypto'))
      .limit(1);
    if (!walletAccountType) throw new Error('Account type "crypto" not found');

    const [cryptoTokenType] = await db
      .select()
      .from(schema.tokenTypes)
      .where(eq(schema.tokenTypes.code, 'crypto'))
      .limit(1);
    if (!cryptoTokenType) throw new Error('Token type "crypto" not found');

    if (!input.displayName) {
      try {
        const ensName = await this.walletDiscovery.resolveEnsName(input.address);
        if (ensName) {
          input.displayName = ensName;
          logger.info({ ensName }, 'Resolved ENS name on backend for wallet import');
        }
      } catch {
        // Non-critical — account names will use shortened address.
      }
    }

    const errors: ImportWalletResult['errors'] = [];
    const chains = await this.fetchChainData(input, userId, detectedInstitutionIds, errors);

    const targets: IntegrationImportTarget[] = chains.map((chain) => {
      const accountInfo: DiscoveredAccountInfo = {
        externalId: chain.preExistingAccountId ?? input.address,
        name: chain.accountName,
        accountType: 'crypto',
        description: `Crypto wallet on ${chain.institution.name}`,
      };
      return {
        institution: chain.institution,
        accountInfo,
        snapshots: chain.snapshots,
        preExistingAccountId: chain.preExistingAccountId,
        accountTypeId: walletAccountType.id,
        accountName: chain.accountName,
        accountDescription: `Crypto wallet on ${chain.institution.name}`,
        accountMetadataPatch: {
          walletAddress: input.address,
          chainId: chain.chainId,
          chainName: chain.institution.name,
          displayName: input.displayName,
          userWalletId: userWallet.id,
          migrated: true,
        },
      };
    });

    const importResult = await this.integrationImportService.import(targets, {
      userId,
      baseCurrencyId: user.baseCurrencyId,
      sourceTag: 'blockchain',
      zeroStaleHoldings: false,
      cryptoTokenTypeId: cryptoTokenType.id,
      tokenTypeMap: { crypto: cryptoTokenType.id },
      defaultDecimals: () => 18,
      resolveTokenTypeId: (_snapshot, fallbackCryptoTypeId) => fallbackCryptoTypeId,
      transactionName: 'importWallet',
      transactionTimeoutMs: 120_000,
    });

    for (const err of importResult.errors) {
      errors.push({
        chainId: err.accountInfo.externalId,
        chainName: 'Unknown',
        error: err.error,
      });
    }

    await this.storePublicRpcMarkers(
      userId,
      chains.map((c) => c.institution.id),
      input.address
    );

    const prices = await this.priceWarmupService.warm({
      userId,
      tokenIds: importResult.tokenIds,
      rescanScamScores: true,
    });

    const accountById = new Map(importResult.accounts.map((a) => [a.id, a]));
    const chainByInstitutionId = new Map(chains.map((c) => [c.institution.id, c]));

    const accounts: ImportWalletResult['accounts'] = importResult.accounts.map((a) => {
      const chain = chainByInstitutionId.get(a.institutionId);
      return {
        id: a.id,
        name: a.name,
        chainId: chain?.chainId ?? a.institutionId,
        chainName: a.institutionName,
        institutionId: a.institutionId,
        institutionName: a.institutionName,
      };
    });

    const holdings: ImportWalletResult['holdings'] = importResult.holdings.map((h) => {
      const account = accountById.get(h.accountId);
      const price = prices.get(h.tokenId);
      return {
        id: h.id,
        accountId: h.accountId,
        accountName: h.accountName,
        chainName: account?.institutionName ?? '',
        tokenId: h.tokenId,
        tokenSymbol: h.tokenSymbol,
        tokenName: h.tokenName,
        tokenIconUrl: h.tokenIconUrl,
        tokenIsNew: h.tokenIsNew,
        tokenScamProbability: h.tokenScamProbability,
        balance: h.balance,
        priceInBaseCurrency: price && price !== '0' ? price : null,
      };
    });

    const result: ImportWalletResult = {
      walletLabel: this.computeWalletLabel(input.displayName, input.address),
      accounts,
      holdings,
      chainsDetected: detectedInstitutionIds.length,
      tokensImported: holdings.length,
      errors,
    };

    logger.info(
      {
        userId,
        institutionsDetected: detectedInstitutionIds.length,
        accountsCreated: result.accounts.length,
        holdingsCreated: result.holdings.length,
        errorsCount: errors.length,
        success: result.accounts.length > 0 || result.holdings.length > 0,
      },
      'Wallet import completed with integrations'
    );

    return result;
  }

  /**
   * Phase 1 of the review-aware wallet-import flow. Detects chains +
   * fetches balances + serializes the result so a downstream mutation
   * can consume it. Does NOT create accounts or holdings.
   */
  async prepareReview(
    input: ImportWalletInput,
    userId: string
  ): Promise<PrepareWalletReviewResult> {
    logger.info(
      { userId, address: `${input.address.substring(0, 10)}...` },
      'Starting wallet import — review-only phase'
    );

    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (!user) throw new Error('User not found');

    const detectedInstitutionIds = await this.resolveDetectedInstitutionIds(input, userId);
    const userWallet =
      detectedInstitutionIds.length > 0
        ? await this.upsertUserWallet(input, userId, detectedInstitutionIds)
        : null;

    const [walletAccountType] = await db
      .select()
      .from(schema.accountTypes)
      .where(eq(schema.accountTypes.code, 'crypto'))
      .limit(1);
    if (!walletAccountType) throw new Error('Account type "crypto" not found');

    const [cryptoTokenType] = await db
      .select()
      .from(schema.tokenTypes)
      .where(eq(schema.tokenTypes.code, 'crypto'))
      .limit(1);
    if (!cryptoTokenType) throw new Error('Token type "crypto" not found');

    if (!input.displayName) {
      try {
        const ensName = await this.walletDiscovery.resolveEnsName(input.address);
        if (ensName) input.displayName = ensName;
      } catch {
        /* non-critical */
      }
    }

    const errors: ImportWalletResult['errors'] = [];
    const prepared = await this.fetchChainData(input, userId, detectedInstitutionIds, errors);

    const chains: WalletReviewChain[] = prepared.map((c) => ({
      institutionId: c.institution.id,
      institutionName: c.institution.name,
      institutionCode: c.institutionCode,
      chainId: c.chainId,
      accountName: c.accountName,
      preExistingAccountId: c.preExistingAccountId,
      snapshots: c.snapshots.map((s) => ({
        externalId: s.externalId,
        balance: s.balance,
        capturedAt: s.capturedAt.toISOString(),
        tokenIdentity: {
          symbol: s.tokenIdentity.symbol ?? undefined,
          name: s.tokenIdentity.name ?? undefined,
          decimals:
            typeof s.tokenIdentity.decimals === 'number' ? s.tokenIdentity.decimals : undefined,
          iconUrl: s.tokenIdentity.iconUrl ?? null,
          providerMetadata: s.tokenIdentity.providerMetadata ?? undefined,
        },
      })),
    }));

    return {
      walletLabel: this.computeWalletLabel(input.displayName, input.address),
      walletId: userWallet?.id ?? '',
      userBaseCurrencyId: user.baseCurrencyId,
      cryptoTokenTypeId: cryptoTokenType.id,
      walletAccountTypeId: walletAccountType.id,
      chains,
      chainsDetected: detectedInstitutionIds.length,
      errors,
    };
  }

  /**
   * Phase 2 — runs the import using user-approved snapshots. Skips
   * detection + balance fetch (already done by `prepareReview`); calls
   * IntegrationImportService.import + priceWarmup directly.
   */
  async importFromReview(
    args: {
      address: string;
      displayName?: string;
      walletId: string;
      userBaseCurrencyId: string | null;
      cryptoTokenTypeId: string;
      walletAccountTypeId: string;
      chains: WalletReviewChain[];
    },
    userId: string
  ): Promise<ImportWalletResult> {
    if (args.chains.length === 0) {
      return {
        walletLabel: this.computeWalletLabel(args.displayName, args.address),
        accounts: [],
        holdings: [],
        chainsDetected: 0,
        tokensImported: 0,
        errors: [],
      };
    }

    const targets: IntegrationImportTarget[] = await Promise.all(
      args.chains.map(async (chain) => {
        const [institution] = await db
          .select()
          .from(schema.institutions)
          .where(eq(schema.institutions.id, chain.institutionId))
          .limit(1);
        if (!institution) {
          throw new Error(`Institution ${chain.institutionId} no longer exists`);
        }
        const accountInfo: DiscoveredAccountInfo = {
          externalId: chain.preExistingAccountId ?? args.address,
          name: chain.accountName,
          accountType: 'crypto',
          description: `Crypto wallet on ${institution.name}`,
        };
        const snapshots: HoldingSnapshot[] = chain.snapshots.map((s) => ({
          externalId: s.externalId,
          balance: s.balance,
          capturedAt: new Date(s.capturedAt),
          tokenIdentity: {
            symbol: s.tokenIdentity.symbol,
            name: s.tokenIdentity.name,
            decimals: s.tokenIdentity.decimals,
            iconUrl: s.tokenIdentity.iconUrl ?? null,
            providerMetadata: s.tokenIdentity.providerMetadata,
          },
        }));
        return {
          institution,
          accountInfo,
          snapshots,
          preExistingAccountId: chain.preExistingAccountId,
          accountTypeId: args.walletAccountTypeId,
          accountName: chain.accountName,
          accountDescription: `Crypto wallet on ${institution.name}`,
          accountMetadataPatch: {
            walletAddress: args.address,
            chainId: chain.chainId,
            chainName: institution.name,
            displayName: args.displayName,
            userWalletId: args.walletId,
            migrated: true,
          },
        } satisfies IntegrationImportTarget;
      })
    );

    const importResult = await this.integrationImportService.import(targets, {
      userId,
      baseCurrencyId: args.userBaseCurrencyId,
      sourceTag: 'blockchain',
      zeroStaleHoldings: false,
      cryptoTokenTypeId: args.cryptoTokenTypeId,
      tokenTypeMap: { crypto: args.cryptoTokenTypeId },
      defaultDecimals: () => 18,
      resolveTokenTypeId: (_snapshot, fallbackCryptoTypeId) => fallbackCryptoTypeId,
      transactionName: 'importWallet',
      transactionTimeoutMs: 120_000,
    });

    await this.storePublicRpcMarkers(
      userId,
      args.chains.map((c) => c.institutionId),
      args.address
    );

    const prices = await this.priceWarmupService.warm({
      userId,
      tokenIds: importResult.tokenIds,
      rescanScamScores: true,
    });

    const accountById = new Map(importResult.accounts.map((a) => [a.id, a]));
    const chainByInstitutionId = new Map(args.chains.map((c) => [c.institutionId, c]));

    const accounts: ImportWalletResult['accounts'] = importResult.accounts.map((a) => {
      const chain = chainByInstitutionId.get(a.institutionId);
      return {
        id: a.id,
        name: a.name,
        chainId: chain?.chainId ?? a.institutionId,
        chainName: a.institutionName,
        institutionId: a.institutionId,
        institutionName: a.institutionName,
      };
    });
    const holdings: ImportWalletResult['holdings'] = importResult.holdings.map((h) => {
      const account = accountById.get(h.accountId);
      const price = prices.get(h.tokenId);
      return {
        id: h.id,
        accountId: h.accountId,
        accountName: h.accountName,
        chainName: account?.institutionName ?? '',
        tokenId: h.tokenId,
        tokenSymbol: h.tokenSymbol,
        tokenName: h.tokenName,
        tokenIconUrl: h.tokenIconUrl,
        tokenIsNew: h.tokenIsNew,
        tokenScamProbability: h.tokenScamProbability,
        balance: h.balance,
        priceInBaseCurrency: price && price !== '0' ? price : null,
      };
    });

    return {
      walletLabel: this.computeWalletLabel(args.displayName, args.address),
      accounts,
      holdings,
      chainsDetected: args.chains.length,
      tokensImported: holdings.length,
      errors: importResult.errors.map((err) => ({
        chainId: err.accountInfo.externalId,
        chainName: 'Unknown',
        error: err.error,
      })),
    };
  }

  private async resolveDetectedInstitutionIds(
    input: ImportWalletInput,
    userId: string
  ): Promise<string[]> {
    if (input.detectedInstitutionIds && input.detectedInstitutionIds.length > 0) {
      logger.info(
        {
          userId,
          detectedInstitutionsCount: input.detectedInstitutionIds.length,
          institutionIds: input.detectedInstitutionIds,
        },
        'Using pre-detected institution IDs (skipping redundant detection)'
      );
      return input.detectedInstitutionIds;
    }

    const detected = await this.walletDiscovery.detectWalletInstitutions(input.address);
    logger.info(
      {
        userId,
        detectedInstitutionsCount: detected.length,
        institutionIds: detected,
      },
      'Wallet chain detection completed'
    );
    return detected;
  }

  private async upsertUserWallet(
    input: ImportWalletInput,
    userId: string,
    detectedInstitutionIds: string[]
  ) {
    let userWallet = await this.userWalletService.getWalletByAddress(userId, input.address);
    if (!userWallet) {
      userWallet = await this.userWalletService.createWallet({
        userId,
        walletAddress: input.address,
        institutionIds: detectedInstitutionIds,
        label: input.displayName,
        isActive: true,
      });
      logger.info(
        { walletId: userWallet.id, institutionIds: detectedInstitutionIds },
        'Created user wallet entry'
      );
    } else {
      const existingIds = (userWallet.institutionIds as string[]) || [];
      const mergedIds = Array.from(new Set([...existingIds, ...detectedInstitutionIds]));
      if (mergedIds.length > existingIds.length) {
        userWallet = await this.userWalletService.updateWallet(userWallet.id, {
          institutionIds: mergedIds,
        });
        logger.info(
          { walletId: userWallet.id, institutionIds: mergedIds },
          'Updated user wallet with new institutions'
        );
      }
    }
    return userWallet;
  }

  private async fetchChainData(
    input: ImportWalletInput,
    userId: string,
    detectedInstitutionIds: string[],
    errors: ImportWalletResult['errors']
  ): Promise<PreparedChain[]> {
    const chains: PreparedChain[] = [];
    const registry = Container.get(ProviderRegistry);

    for (const institutionId of detectedInstitutionIds) {
      try {
        const institutionCode = await this.walletDiscovery.resolveInstitutionCode(institutionId);
        const provider = institutionCode ? registry.getBalanceFetcher(institutionCode) : null;
        if (!institutionCode || !provider) {
          errors.push({
            chainId: institutionId,
            chainName: 'Unknown',
            error: 'No registered balance provider',
          });
          continue;
        }

        const [institution] = await db
          .select()
          .from(schema.institutions)
          .where(eq(schema.institutions.id, institutionId))
          .limit(1);
        if (!institution) {
          errors.push({
            chainId: institutionId,
            chainName: 'Unknown',
            error: 'Institution not found',
          });
          continue;
        }

        const mapping = await this.mappingRepository.findByInstitutionId(institutionId);
        if (!mapping) {
          errors.push({
            chainId: institutionId,
            chainName: institution.name,
            error: 'Chain mapping not found',
          });
          continue;
        }

        const accountName = this.generateAccountName(
          institution.name,
          input.displayName || input.address
        );

        const [existingAccount] = await db
          .select()
          .from(schema.accounts)
          .where(
            and(
              eq(schema.accounts.userId, userId),
              eq(schema.accounts.institutionId, institution.id),
              eq(schema.accounts.name, accountName)
            )
          )
          .limit(1);

        const ctx = makeProviderContext({
          userId,
          institutionId,
          institutionCode,
          resolveCredentials: async () => ({ walletAddress: input.address }),
        });

        const snapshots = await provider.fetchBalances(ctx);
        chains.push({
          institution,
          institutionCode,
          chainId: mapping.chainId,
          snapshots,
          preExistingAccountId: existingAccount?.id,
          accountName,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(
          { userId, institutionId, error: errorMessage },
          'Failed to fetch blockchain data for institution'
        );
        errors.push({ chainId: institutionId, chainName: 'Unknown', error: errorMessage });
      }
    }

    return chains;
  }

  // Public-RPC marker rows. Uses 'enqueued' import status so the
  // orphan-credentials reconciler doesn't sweep these and re-enqueue
  // them as exchange-import — they're public-RPC integrations, not
  // pending API-key imports.
  //
  // Carries `walletAddress` in the payload so the per-chain
  // transactions provider (`BaseEvmProvider.resolveRequestParams`)
  // can read it back. Without this, the EVM tx-import sends an empty
  // `address=` query to Etherscan and gets 0 rows back.
  private async storePublicRpcMarkers(
    userId: string,
    institutionIds: string[],
    walletAddress?: string
  ): Promise<void> {
    for (const institutionId of institutionIds) {
      try {
        const existing = await this.integrationCredentialsService.getCredentials(
          userId,
          institutionId
        );
        if (!existing) {
          const payload: Record<string, unknown> = { type: 'public_rpc' };
          if (walletAddress) payload.walletAddress = walletAddress;
          await this.integrationCredentialsService.storeCredentials(
            userId,
            institutionId,
            payload,
            'rpc',
            undefined,
            'enqueued'
          );
        }
      } catch (error) {
        logger.debug(
          {
            institutionId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to store credentials (non-critical)'
        );
      }
    }
  }

  private computeWalletLabel(displayName: string | undefined, address: string): string {
    if (displayName) return displayName;
    if (address.length > 20) {
      return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
    }
    return address;
  }

  private generateAccountName(chainName: string, displayName: string): string {
    const isEthereumAddress = /^0x[0-9a-fA-F]{40}$/.test(displayName);
    const isTronAddress = /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(displayName);
    const isBitcoinAddress =
      /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(displayName) ||
      /^bc1[a-z0-9]{39,59}$/.test(displayName);
    const isSolanaAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(displayName);

    const isAddress = isEthereumAddress || isTronAddress || isBitcoinAddress || isSolanaAddress;

    if (isAddress && displayName.length > 20) {
      const shortened = `${displayName.substring(0, 6)}...${displayName.substring(displayName.length - 4)}`;
      return `${chainName} - ${shortened}`;
    }

    return `${chainName} - ${displayName}`;
  }
}

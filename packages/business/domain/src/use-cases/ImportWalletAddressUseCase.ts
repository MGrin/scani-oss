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
import { type HoldingSnapshot, toJobNotice } from '@scani/providers/core/types';
import { and, eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { makeProviderContext, type SelfCredentialedProviderContext } from '../lib/provider-context';
import { HoldingExclusionRepository } from '../repositories/HoldingExclusionRepository';
import { InstitutionBlockchainMappingRepository } from '../repositories/InstitutionBlockchainMappingRepository';
import {
  type ChainProbeFailure,
  type DiscoveredAccountInfo,
  IntegrationCredentialsService,
  IntegrationImportService,
  type IntegrationImportTarget,
  PriceWarmupService,
  UserWalletService,
  WALLET_BALANCE_SYNC_SOURCE,
  WalletDiscoveryService,
} from '../services';
import { exitedPositionSnapshots } from './lib/exitedPositions';
import { safeStatus } from './lib/safeStatus';

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
    /**
     * A position the wallet TRADED and no longer holds, offered so its history
     * has somewhere to land (SC-398). Absent on a current balance.
     *
     * Carried rather than derived from `balance === '0'`. That equivalence is
     * true — `fetchBalances` filters `.gt(0)` — and it is true because of a
     * line in a provider two packages away, so a reader of this payload cannot
     * check it and a change there would silently reinterpret every row here.
     * The picker renders a different sentence for these, and a sentence about
     * somebody's money should not rest on an invariant nobody can see.
     */
    exitedPosition?: boolean;
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
  /** `externalId`s in `snapshots` that are closed positions rather than
      current balances (SC-398). Kept beside the list rather than derived from
      `balance === '0'` at read time: that equivalence holds only because
      `fetchBalances` filters `.gt(0)` somewhere else entirely, and a reader
      three layers away cannot see the filter that makes it true. */
  exitedExternalIds: Set<string>;
  preExistingAccountId?: string;
  accountName: string;
}

@Service()
export class ImportWalletAddressUseCase {
  private readonly walletDiscovery = Container.get(WalletDiscoveryService);
  private readonly userWalletService = Container.get(UserWalletService);
  private readonly integrationCredentialsService = Container.get(IntegrationCredentialsService);
  private readonly mappingRepository = Container.get(InstitutionBlockchainMappingRepository);
  private readonly holdingExclusionRepository = Container.get(HoldingExclusionRepository);
  private readonly integrationImportService = Container.get(IntegrationImportService);
  private readonly priceWarmupService = Container.get(PriceWarmupService);

  /**
   * Phase 1 of the review-aware wallet-import flow. Detects chains +
   * fetches balances + serializes the result so a downstream mutation
   * can consume it. Does NOT create accounts or holdings.
   */
  async prepareReview(
    input: ImportWalletInput,
    userId: string,
    onStatus?: (message: string) => void | Promise<void>
  ): Promise<PrepareWalletReviewResult> {
    logger.info(
      { userId, address: `${input.address.substring(0, 10)}...` },
      'Starting wallet import — review-only phase'
    );

    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (!user) throw new Error('User not found');

    await safeStatus(onStatus, 'Detecting blockchain networks…');
    const { institutionIds: detectedInstitutionIds, failures: probeFailures } =
      await this.resolveDetectedInstitutionIds(input, userId);
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

    // A chain that could not be probed is reported, not dropped. Without
    // this an upstream 429 produced `chains: [], errors: []` — the same
    // payload a genuinely empty wallet produces, and the same payload a
    // regression in detection would produce (SC-490).
    const errors: ImportWalletResult['errors'] = probeFailures.map((f) => ({
      chainId: f.institutionCode,
      chainName: f.chainName,
      error: `Chain could not be checked: ${f.error}`,
    }));
    const prepared = await this.fetchChainData(
      input,
      userId,
      detectedInstitutionIds,
      errors,
      onStatus
    );

    await safeStatus(onStatus, 'Preparing review…');

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
        // `undefined` rather than `false` so a wallet with no closed positions
        // serializes byte-identically to before — `JSON.stringify` drops the
        // key, and this payload is stored on `user_jobs.result` under a size
        // budget (`result-truncator`).
        exitedPosition: c.exitedExternalIds.has(s.externalId) ? true : undefined,
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
      sourceTag: WALLET_BALANCE_SYNC_SOURCE,
      // `args.chains` carries only the snapshots the user kept at review —
      // the ones they dropped went to `holding_exclusions` — so every row
      // this creates was shown to a person and kept (SC-277).
      arrival: 'user_confirmed',
      zeroStaleHoldings: false,
      cryptoTokenTypeId: args.cryptoTokenTypeId,
      tokenTypeMap: { crypto: args.cryptoTokenTypeId },
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
  ): Promise<{ institutionIds: string[]; failures: ChainProbeFailure[] }> {
    if (input.detectedInstitutionIds && input.detectedInstitutionIds.length > 0) {
      logger.info(
        {
          userId,
          detectedInstitutionsCount: input.detectedInstitutionIds.length,
          institutionIds: input.detectedInstitutionIds,
        },
        'Using pre-detected institution IDs (skipping redundant detection)'
      );
      return { institutionIds: input.detectedInstitutionIds, failures: [] };
    }

    const { institutionIds, failures } = await this.walletDiscovery.detectWalletInstitutions(
      input.address
    );
    logger.info(
      {
        userId,
        detectedInstitutionsCount: institutionIds.length,
        institutionIds,
        failedChains: failures.map((f) => f.institutionCode),
      },
      'Wallet chain detection completed'
    );
    return { institutionIds, failures };
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
    errors: ImportWalletResult['errors'],
    onStatus?: (message: string) => void | Promise<void>
  ): Promise<PreparedChain[]> {
    const chains: PreparedChain[] = [];
    const registry = Container.get(ProviderRegistry);

    let chainIndex = 0;
    const total = detectedInstitutionIds.length;
    for (const institutionId of detectedInstitutionIds) {
      chainIndex++;
      // Tracked outside the try because the catch reports them: an error
      // pushed as `chainName: 'Unknown'` is what the user reads on the
      // review card, and it does not tell them which half of their wallet
      // is missing (SC-139). Narrowed as soon as each is resolved.
      let chainName = 'Unknown';
      let chainKey = institutionId;
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
        chainName = institution.name;

        const mapping = await this.mappingRepository.findByInstitutionId(institutionId);
        if (!mapping) {
          errors.push({
            chainId: institutionId,
            chainName: institution.name,
            error: 'Chain mapping not found',
          });
          continue;
        }
        chainKey = mapping.chainId;

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
          onStatus,
        });

        await safeStatus(
          onStatus,
          `Fetching balances on ${institution.name} (${chainIndex}/${total})…`
        );
        const balances = await provider.fetchBalances(ctx);

        // A position the wallet TRADED and no longer holds has no balance, so
        // the fetch above cannot see it — and the review is the only place a
        // holding for it can be created, because `TransactionRouter` resolves
        // wallet sources find-only and drops every leg of a token with no
        // holding. Buy and sell alike: the whole life of the position is
        // invisible, with no row anywhere to notice (SC-398).
        //
        // A failure here does NOT fail the chain. The balances are the primary
        // answer and they are in hand; what is lost is the extra offer, and it
        // is reported rather than swallowed — a silent fallback to
        // balances-only is exactly the omission this is fixing, and it would
        // be indistinguishable from a wallet that never traded anything.
        const exited = await this.offerExitedPositions({
          registry,
          institutionCode,
          institutionId: institution.id,
          institutionName: institution.name,
          chainKey,
          ctx,
          userId,
          balances,
          errors,
          onStatus,
        });

        chains.push({
          institution,
          institutionCode,
          chainId: mapping.chainId,
          snapshots: [...balances, ...exited],
          exitedExternalIds: new Set(exited.map((s) => s.externalId)),
          preExistingAccountId: existingAccount?.id,
          accountName,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        // The chain's own name, not 'Unknown': this string is what the
        // review card shows the user when a chain could not be read, and
        // "Unknown: rate limited" tells nobody which wallet half is
        // missing (SC-139). `institution` is resolved above the try's
        // failing calls, so it is available here.
        logger.error(
          { userId, institutionId, chainName, errorMessage },
          `Failed to fetch blockchain data for ${chainName}: ${errorMessage}`
        );
        errors.push({ chainId: chainKey, chainName, error: errorMessage });
      }
    }

    return chains;
  }

  /**
   * The closed positions this chain's provider can account for, ready to sit
   * beside the current balances on the review card (SC-398).
   *
   * Three things this deliberately does NOT do:
   *
   *  - **It does not fail the chain.** The balances are the answer the user
   *    came for and they are already in hand. A provider that cannot walk the
   *    history costs the extra offer and nothing else.
   *  - **It does not stay quiet about that.** The message goes into `errors`,
   *    which is what the card renders and what turns the outcome `partial`.
   *    Falling back silently to balances-only reproduces the omission the
   *    ticket is about, and a reader would have no way to tell the two apart.
   *  - **It does not guess for a chain that cannot answer.** `fetchExitedPositions`
   *    is optional precisely because "the account holder authorised this" is
   *    not derivable everywhere; Bitcoin, TON and the exchanges have no such
   *    signal. An absent implementation is today's behaviour and is not a
   *    failure, so it says nothing.
   */
  private async offerExitedPositions(args: {
    registry: ProviderRegistry;
    institutionCode: string;
    institutionId: string;
    institutionName: string;
    chainKey: string;
    ctx: SelfCredentialedProviderContext;
    userId: string;
    balances: readonly HoldingSnapshot[];
    errors: ImportWalletResult['errors'];
    onStatus?: (message: string) => void | Promise<void>;
  }): Promise<HoldingSnapshot[]> {
    const historyProvider = args.registry.getTransactionsFetcher(args.institutionCode);
    if (!historyProvider?.fetchExitedPositions) return [];

    const notes: string[] = [];
    try {
      await safeStatus(args.onStatus, `Looking for past positions on ${args.institutionName}…`);
      const exited = await historyProvider.fetchExitedPositions({
        ...args.ctx,
        institutionCode: args.institutionCode,
        // Keeps the sentence and drops the key: these land in
        // `ImportWalletResult.errors`, a different result shape with no keyed
        // channel yet (SC-434). English here is what ships today, unchanged.
        noteWarning: (reason) => notes.push(toJobNotice(reason).text),
      });
      for (const note of notes) {
        args.errors.push({
          chainId: args.chainKey,
          chainName: args.institutionName,
          error: note,
        });
      }
      if (exited.length === 0) return [];
      const excludedKeys = await this.holdingExclusionRepository.findKeysByUser(args.userId);
      return exitedPositionSnapshots({
        balances: args.balances,
        exited,
        excludedKeys,
        institutionId: args.institutionId,
        capturedAt: new Date(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        { userId: args.userId, institutionCode: args.institutionCode, error: message },
        'Could not read past positions for wallet review'
      );
      args.errors.push({
        chainId: args.chainKey,
        chainName: args.institutionName,
        error: `Past positions could not be read: ${message}. Only tokens you still hold are listed.`,
      });
      return [];
    }
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

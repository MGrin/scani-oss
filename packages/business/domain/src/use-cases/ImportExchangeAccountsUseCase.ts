/**
 * ImportExchangeAccountsUseCase
 *
 * Generic use case for importing exchange accounts after API key validation.
 * Provider-specific knowledge (account discovery, blockchain rejection,
 * source tag) lives here; cross-cutting account + holding work delegates to
 * `IntegrationImportService`, and post-import price warm-up delegates to
 * `PriceWarmupService`.
 */

import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { ProviderRegistry } from '@scani/providers/core/registry';
import type { HoldingSnapshot } from '@scani/providers/core/types';
import { eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { makeProviderContext } from '../lib/provider-context';
import { TokenTypeRepository } from '../repositories/EnumRepositories';
import {
  type DiscoveredAccountInfo,
  IntegrationCredentialsService,
  IntegrationImportService,
  type IntegrationImportTarget,
  PriceWarmupService,
  WalletDiscoveryService,
} from '../services';
import { resolveSnapshotTokenType } from './lib/resolveSnapshotTokenType';
import { safeStatus } from './lib/safeStatus';

const logger = createComponentLogger('use-case:import-exchange-accounts');

export interface ImportExchangeAccountsInput {
  userId: string;
  institutionId: string;
  /**
   * Optional progress sink wired by the BullMQ processor. Most CEX
   * providers complete in a few seconds and don't emit phase messages,
   * but the option is in place so future providers (or instrumentation)
   * can surface mid-flight status without another plumbing pass.
   */
  onStatus?: (message: string) => void | Promise<void>;
}

export interface ImportExchangeAccountsResult {
  accounts: Array<{
    id: string;
    name: string;
    accountType: string;
  }>;
  holdings: Array<{
    id: string;
    accountId: string;
    tokenId: string;
    tokenSymbol: string;
    balance: string;
  }>;
  accountsCreated: number;
  /** Holdings imported (created or updated) for the user, not new catalog tokens. */
  tokensImported: number;
  errors: Array<{
    accountType: string;
    error: string;
  }>;
}

@Service()
export class ImportExchangeAccountsUseCase {
  private readonly walletDiscovery = Container.get(WalletDiscoveryService);
  private readonly integrationCredentialsService = Container.get(IntegrationCredentialsService);
  private readonly tokenTypeRepository = Container.get(TokenTypeRepository);
  private readonly integrationImportService = Container.get(IntegrationImportService);
  private readonly priceWarmupService = Container.get(PriceWarmupService);

  async execute(input: ImportExchangeAccountsInput): Promise<ImportExchangeAccountsResult> {
    logger.info(
      { userId: input.userId, institutionId: input.institutionId },
      'Starting exchange accounts import'
    );

    const result: ImportExchangeAccountsResult = {
      accounts: [],
      holdings: [],
      accountsCreated: 0,
      tokensImported: 0,
      errors: [],
    };

    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, input.userId))
      .limit(1);
    if (!user) throw new Error('User not found');

    const credentials = await this.integrationCredentialsService.getDecryptedCredentials(
      input.userId,
      input.institutionId
    );
    if (!credentials) throw new Error('No credentials found for this institution');

    const institutionCode = await this.walletDiscovery.resolveInstitutionCode(input.institutionId);
    const registry = Container.get(ProviderRegistry);
    const provider = institutionCode ? registry.getBalanceFetcher(institutionCode) : null;
    if (!institutionCode || !provider) {
      throw new Error(`No registered balance provider for institution: ${input.institutionId}`);
    }

    if (BLOCKCHAIN_INSTITUTION_CODES.has(institutionCode)) {
      throw new Error(
        `Exchange-import targeted a blockchain-type institution (${input.institutionId} → ${institutionCode}). Use wallet-import to sync on-chain holdings.`
      );
    }

    const ctx = makeProviderContext({
      userId: input.userId,
      institutionId: input.institutionId,
      institutionCode,
      resolveCredentials: async () => credentials,
      onStatus: input.onStatus,
    });

    await safeStatus(input.onStatus, `Discovering accounts on ${institutionCode}…`);
    const accountDiscoverer = registry.getAccountDiscoverer(institutionCode);
    const discoveredAccounts = accountDiscoverer
      ? await accountDiscoverer.fetchAccounts(ctx)
      : [
          {
            externalId: 'main',
            label: 'Main',
            metadata: { provider: institutionCode, accountType: 'SPOT' },
          },
        ];
    if (discoveredAccounts.length === 0) {
      throw new Error('Exchange import failed: Exchange returned no accounts');
    }

    const discoveredAccountInfos: DiscoveredAccountInfo[] = discoveredAccounts.map((a) => ({
      externalId: a.externalId,
      name: a.label,
      accountType: ((a.metadata?.accountType as string) ?? 'SPOT').toString(),
      description: a.metadata?.description as string | undefined,
      metadata: a.metadata,
      isActive: true,
    }));

    const targetsRaw: Array<{ accountInfo: DiscoveredAccountInfo; snapshots: HoldingSnapshot[] }> =
      [];
    let accountIndex = 0;
    for (const accountInfo of discoveredAccountInfos) {
      accountIndex++;
      await safeStatus(
        input.onStatus,
        `Fetching balances for ${accountInfo.name} (${accountIndex}/${discoveredAccountInfos.length})…`
      );
      let snapshots: HoldingSnapshot[] = [];
      try {
        snapshots = await provider.fetchBalances(ctx);
      } catch (err) {
        result.errors.push({
          accountType: accountInfo.accountType,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      targetsRaw.push({ accountInfo, snapshots });
    }

    const totalHoldings = targetsRaw.reduce((sum, a) => sum + a.snapshots.length, 0);
    if (totalHoldings === 0 && result.errors.length > 0) {
      const reason = result.errors.map((e) => e.error).join('; ');
      throw new Error(`Exchange import failed: ${reason}`);
    }

    const [institution] = await db
      .select()
      .from(schema.institutions)
      .where(eq(schema.institutions.id, input.institutionId))
      .limit(1);
    if (!institution) throw new Error(`Institution not found: ${input.institutionId}`);

    const sourceTag = `import_${institution.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;

    const [cryptoAccountType] = await db
      .select()
      .from(schema.accountTypes)
      .where(eq(schema.accountTypes.code, 'crypto'))
      .limit(1);
    if (!cryptoAccountType) throw new Error('Crypto account type not found');

    const cryptoTokenType = await this.tokenTypeRepository.findByCode('crypto');
    const fiatTokenType = await this.tokenTypeRepository.findByCode('fiat');
    const stockTokenType = await this.tokenTypeRepository.findByCode('stock');
    if (!cryptoTokenType) throw new Error('Crypto token type not found');

    const tokenTypeMap: Record<string, string> = {
      crypto: cryptoTokenType.id,
      ...(fiatTokenType && { fiat: fiatTokenType.id }),
      ...(stockTokenType && { stock: stockTokenType.id }),
    };

    const targets: IntegrationImportTarget[] = targetsRaw.map(({ accountInfo, snapshots }) => ({
      institution,
      accountInfo,
      snapshots,
      accountTypeId: cryptoAccountType.id,
    }));

    await safeStatus(input.onStatus, 'Saving accounts and holdings…');
    const importResult = await this.integrationImportService.import(targets, {
      userId: input.userId,
      baseCurrencyId: user.baseCurrencyId,
      sourceTag,
      zeroStaleHoldings: true,
      skipZeroBalances: true,
      cryptoTokenTypeId: cryptoTokenType.id,
      tokenTypeMap,
      defaultDecimals: (_snapshot, tokenType) => (tokenType === 'fiat' ? 2 : 8),
      resolveTokenTypeId: (snapshot, fallbackCryptoTypeId) =>
        resolveSnapshotTokenType(snapshot, tokenTypeMap, fallbackCryptoTypeId),
      transactionName: 'importExchangeAccounts',
    });

    for (const err of importResult.errors) {
      result.errors.push({
        accountType: err.accountInfo.accountType,
        error: err.error,
      });
    }

    result.accountsCreated = importResult.accounts.length;
    result.tokensImported = importResult.holdings.length;

    result.accounts = importResult.accounts.map((a) => ({
      id: a.id,
      name: a.name,
      accountType: a.accountType,
    }));

    // Backwards compatibility — the worker emits per-holding events from
    // `result.holdings`, so we report only newly-created holdings here
    // (matching pre-refactor behaviour). Updated rows aren't surfaced.
    result.holdings = importResult.holdings
      .filter((h) => h.tokenIsNew || !h.isHidden)
      .map((h) => ({
        id: h.id,
        accountId: h.accountId,
        tokenId: h.tokenId,
        tokenSymbol: h.tokenSymbol,
        balance: h.balance,
      }));

    logger.info(
      {
        accountsCreated: result.accountsCreated,
        tokensImported: result.tokensImported,
        errorCount: result.errors.length,
      },
      'Exchange accounts import completed'
    );

    if (importResult.tokenIds.length > 0) {
      await this.priceWarmupService.warm({
        userId: input.userId,
        tokenIds: importResult.tokenIds,
      });
    }

    return result;
  }
}

const BLOCKCHAIN_INSTITUTION_CODES = new Set([
  'ethereum',
  'bsc',
  'polygon',
  'avalanche',
  'arbitrum',
  'optimism',
  'base',
  'fantom',
  'cronos',
  'arbitrum-nova',
  'zksync-era',
  'scroll',
  'linea',
  'blast',
  'mantle',
  'opbnb',
  'gnosis',
  'celo',
  'moonbeam',
  'moonriver',
  'bitcoin',
  'solana',
  'tron',
  'ton',
]);

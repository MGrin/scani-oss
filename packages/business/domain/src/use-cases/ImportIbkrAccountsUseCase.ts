/**
 * ImportIbkrAccountsUseCase
 *
 * IBKR-specific orchestrator for Flex Query account + holdings import.
 * IBKR-only behaviour (strict fiat/stock token type resolution, fuzzy
 * stock-suffix matching) lives here; cross-cutting work delegates to
 * `IntegrationImportService` and `PriceWarmupService`.
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
import { TokenRepository } from '../repositories/TokenRepository';
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

const logger = createComponentLogger('use-case:import-ibkr-accounts');

export interface ImportIbkrAccountsInput {
  userId: string;
  institutionId: string;
  /**
   * Optional progress sink wired by the BullMQ processor so the UI can
   * surface "Waiting for IBKR — generating report (attempt N/24)…" while
   * the Flex Query report is being prepared upstream.
   */
  onStatus?: (message: string) => void | Promise<void>;
}

export interface ImportIbkrAccountsResult {
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
export class ImportIbkrAccountsUseCase {
  private readonly walletDiscovery = Container.get(WalletDiscoveryService);
  private readonly integrationCredentialsService = Container.get(IntegrationCredentialsService);
  private readonly tokenTypeRepository = Container.get(TokenTypeRepository);
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly integrationImportService = Container.get(IntegrationImportService);
  private readonly priceWarmupService = Container.get(PriceWarmupService);

  async execute(input: ImportIbkrAccountsInput): Promise<ImportIbkrAccountsResult> {
    logger.info(
      { userId: input.userId, institutionId: input.institutionId },
      'Starting IBKR accounts import'
    );

    const result: ImportIbkrAccountsResult = {
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

    const institutionCode =
      (await this.walletDiscovery.resolveInstitutionCode(input.institutionId)) ?? 'ibkr';
    const registry = Container.get(ProviderRegistry);
    const provider = registry.getBalanceFetcher(institutionCode);
    const accountDiscoverer = registry.getAccountDiscoverer(institutionCode);
    if (!provider) {
      throw new Error(`No registered balance provider for institution: ${input.institutionId}`);
    }

    const ctx = makeProviderContext({
      userId: input.userId,
      institutionId: input.institutionId,
      institutionCode,
      resolveCredentials: async () => credentials,
      onStatus: input.onStatus,
    });

    const discoveredAccounts = accountDiscoverer
      ? await accountDiscoverer.fetchAccounts(ctx)
      : [
          {
            externalId: 'main',
            label: 'Main',
            metadata: { provider: 'ibkr', accountType: 'PORTFOLIO' },
          },
        ];
    if (discoveredAccounts.length === 0) {
      throw new Error('IBKR import failed: IBKR returned no accounts');
    }

    const discoveredAccountInfos: DiscoveredAccountInfo[] = discoveredAccounts.map((a) => ({
      externalId: a.externalId,
      name: a.label,
      accountType: ((a.metadata?.accountType as string) ?? 'PORTFOLIO').toString(),
      description: a.metadata?.description as string | undefined,
      metadata: a.metadata,
      isActive: true,
    }));

    const targetsRaw: Array<{ accountInfo: DiscoveredAccountInfo; snapshots: HoldingSnapshot[] }> =
      [];

    // IBKR's BalanceProvider doesn't filter by sub-account (the Flex
    // Query returns the full portfolio in one shot). Run fetchBalances
    // once per discovered account; for IBKR they all return the same
    // data, but the per-account loop leaves room for future
    // multi-portfolio support.
    for (const accountInfo of discoveredAccountInfos) {
      let snapshots: HoldingSnapshot[] = [];
      try {
        // The provider emits its own per-retry status messages during
        // the long Flex Query poll. The use-case-level message here
        // marks the boundary so the user sees we've moved past account
        // discovery.
        await safeStatus(input.onStatus, 'Requesting Flex Query report from IBKR…');
        snapshots = await provider.fetchBalances(ctx);
      } catch (err) {
        result.errors.push({
          accountType: accountInfo.accountType,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      targetsRaw.push({ accountInfo, snapshots });
    }

    const totalSnapshots = targetsRaw.reduce((sum, a) => sum + a.snapshots.length, 0);
    if (totalSnapshots === 0 && result.errors.length > 0) {
      const reason = result.errors.map((e) => e.error).join('; ');
      throw new Error(`IBKR import failed: ${reason}`);
    }

    const [institution] = await db
      .select()
      .from(schema.institutions)
      .where(eq(schema.institutions.id, input.institutionId))
      .limit(1);
    if (!institution) throw new Error(`Institution not found: ${input.institutionId}`);

    const [investmentAccountType] = await db
      .select()
      .from(schema.accountTypes)
      .where(eq(schema.accountTypes.code, 'investment'))
      .limit(1);
    if (!investmentAccountType) throw new Error('Investment account type not found');

    const fiatTokenType = await this.tokenTypeRepository.findByCode('fiat');
    const stockTokenType = await this.tokenTypeRepository.findByCode('stock');
    if (!fiatTokenType || !stockTokenType) {
      throw new Error('Required token types (fiat, stock) not found');
    }

    const tokenTypeMap: Record<string, string> = {
      fiat: fiatTokenType.id,
      stock: stockTokenType.id,
    };

    const targets: IntegrationImportTarget[] = targetsRaw.map(({ accountInfo, snapshots }) => ({
      institution,
      accountInfo,
      snapshots,
      accountTypeId: investmentAccountType.id,
    }));

    await safeStatus(input.onStatus, 'Saving accounts and holdings…');
    const importResult = await this.integrationImportService.import(targets, {
      userId: input.userId,
      baseCurrencyId: user.baseCurrencyId,
      sourceTag: 'import_ibkr',
      zeroStaleHoldings: true,
      skipZeroBalances: false,
      cryptoTokenTypeId: stockTokenType.id,
      tokenTypeMap,
      defaultDecimals: () => 2,
      // IBKR Flex Query returns equity positions AND per-currency cash
      // balances in the same statement. Cash legs are tagged
      // `tokenType: 'fiat'` by the provider so they resolve to the
      // existing fiat USD/EUR/… rows; everything else (equities, ETFs)
      // falls through to stock.
      resolveTokenTypeId: (snapshot, _fallback) =>
        resolveSnapshotTokenType(snapshot, tokenTypeMap, stockTokenType.id),
      // IBKR provides bare symbols (e.g., "XEQT") but the DB may already
      // carry a suffixed variant (e.g., "XEQT.TO"). Try a fuzzy match
      // before find-or-create so we dedup against the existing token.
      postProcessTokenMapping: async (mapping, _snapshot, holding, tokenTypeId, tx) => {
        if (holding.symbol.includes('.')) return mapping;
        const existingSuffixed = await this.tokenRepository.findBySymbolPrefixAndType(
          holding.symbol,
          tokenTypeId,
          tx
        );
        if (existingSuffixed) {
          mapping.token.symbol = existingSuffixed.symbol;
          logger.info(
            { ibkrSymbol: holding.symbol, matchedSymbol: existingSuffixed.symbol },
            'Matched IBKR bare symbol to existing suffixed token'
          );
        }
        return mapping;
      },
      transactionName: 'importIbkrAccounts',
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
    result.holdings = importResult.holdings
      .filter((h) => h.tokenIsNew)
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
      'IBKR accounts import completed'
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

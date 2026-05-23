import type { Institution } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { type DatabaseTransaction, withTransaction } from '@scani/db/transaction';
import type { HoldingSnapshot } from '@scani/providers/core/types';
import { isValidDecimalString } from '@scani/shared';
import { and, eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { BaseService } from '../BaseService';
import { TokenService } from '../tokens/TokenService';
import { HoldingService } from './HoldingService';
import {
  type IntegrationHolding,
  projectSnapshotsToHoldings,
  projectSnapshotToTokenMapping,
  type TokenMappingResult,
} from './HoldingSnapshotProjection';

export interface DiscoveredAccountInfo {
  externalId: string;
  name: string;
  accountType: string;
  description?: string;
  metadata?: Record<string, unknown>;
  isActive?: boolean;
}

export interface IntegrationImportTarget {
  institution: Institution;
  accountInfo: DiscoveredAccountInfo;
  snapshots: HoldingSnapshot[];
  // Wallet imports often pre-resolve the existing account by
  // (institution, name) before opening the transaction; pass the id here
  // to skip the in-tx lookup.
  preExistingAccountId?: string;
  // Source-specific account metadata to merge into accounts.metadata
  // (chainId/walletAddress for wallet, accountType/description for
  // exchange/IBKR).
  accountMetadataPatch?: Record<string, unknown>;
  // typeId for the accounts row when creating; sources differ
  // (crypto / investment / …).
  accountTypeId: string;
  // Optional pre-determined target account name (wallet imports compute
  // it from displayName / shortened address).
  accountName?: string;
  // Optional account description for newly-created rows.
  accountDescription?: string;
}

export interface IntegrationImportOptions {
  userId: string;
  baseCurrencyId: string | null;
  // Tag stored on holdings.source — used by the stale-zero pass and
  // downstream sync flows to attribute rows to the right importer.
  sourceTag: string;
  // Wallet imports preserve user-deleted holdings; exchange/IBKR zero
  // any holding that the upstream API stops returning.
  zeroStaleHoldings: boolean;
  // Per-source default decimals (wallet=18 for EVM tokens, IBKR=2,
  // exchange picks 2 for fiat else 8).
  defaultDecimals: (snapshot: HoldingSnapshot, tokenType: string | undefined) => number;
  // Per-source token-type resolution (wallet forces crypto; exchange
  // accepts crypto/fiat/stock; IBKR enforces fiat-or-stock).
  resolveTokenTypeId: (snapshot: HoldingSnapshot, fallbackCryptoTypeId: string) => string;
  // Optional post-processing after token-mapping projection, before
  // find-or-create. IBKR uses this to fuzzy-match bare symbols to
  // existing suffixed tokens (e.g. XEQT → XEQT.TO).
  postProcessTokenMapping?: (
    mapping: TokenMappingResult,
    snapshot: HoldingSnapshot,
    holding: IntegrationHolding,
    tokenTypeId: string,
    tx: DatabaseTransaction
  ) => Promise<TokenMappingResult>;
  // Exchange import skips zero-balance holdings entirely (don't pollute
  // the DB with orphan tokens for empty positions); wallet/IBKR create
  // them so the historical ledger has an anchor.
  skipZeroBalances?: boolean;
  // Crypto fallback typeId for holdings whose tokenType isn't in the
  // tokenTypeMap.
  cryptoTokenTypeId: string;
  // Map of tokenType code → tokenType id (wallet only has crypto;
  // exchange has crypto/fiat/stock; IBKR has fiat/stock).
  tokenTypeMap: Record<string, string>;
  // Wallet flow opens its tx with timeout: 120000 (large multi-chain
  // imports); exchange/IBKR cap at 60s.
  transactionTimeoutMs?: number;
  transactionName?: string;
}

export interface ImportedHolding {
  id: string;
  accountId: string;
  accountName: string;
  tokenId: string;
  tokenSymbol: string;
  tokenName: string;
  tokenIconUrl: string | null;
  tokenIsNew: boolean;
  tokenScamProbability: number;
  balance: string;
  externalId: string | null;
  isHidden: boolean;
}

export interface ImportedAccount {
  id: string;
  name: string;
  institutionId: string;
  institutionName: string;
  accountType: string;
  externalId: string;
  metadata: Record<string, unknown>;
}

export interface IntegrationImportResult {
  accounts: ImportedAccount[];
  holdings: ImportedHolding[];
  tokenIds: string[];
  errors: Array<{ accountInfo: DiscoveredAccountInfo; error: string }>;
}

@Service()
export class IntegrationImportService extends BaseService {
  private readonly holdingService = Container.get(HoldingService);
  private readonly tokenService = Container.get(TokenService);
  private readonly holdingRepository = Container.get(HoldingRepository);

  constructor() {
    super('IntegrationImportService');
  }

  async import(
    targets: IntegrationImportTarget[],
    options: IntegrationImportOptions
  ): Promise<IntegrationImportResult> {
    const result: IntegrationImportResult = {
      accounts: [],
      holdings: [],
      tokenIds: [],
      errors: [],
    };
    if (targets.length === 0) return result;

    const tokenIdSet = new Set<string>();

    await withTransaction(
      async (tx) => {
        for (const target of targets) {
          try {
            await this.processTarget(target, options, result, tokenIdSet, tx);
          } catch (error) {
            result.errors.push({
              accountInfo: target.accountInfo,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      },
      {
        name: options.transactionName ?? 'integrationImport',
        timeout: options.transactionTimeoutMs ?? 60_000,
      }
    );

    result.tokenIds = Array.from(tokenIdSet);
    return result;
  }

  private async processTarget(
    target: IntegrationImportTarget,
    options: IntegrationImportOptions,
    result: IntegrationImportResult,
    tokenIdSet: Set<string>,
    tx: DatabaseTransaction
  ): Promise<void> {
    const { accountInfo, snapshots, accountMetadataPatch, preExistingAccountId } = target;
    const eventContext = options.baseCurrencyId
      ? { userId: options.userId, baseCurrencyId: options.baseCurrencyId }
      : undefined;

    const accountId = await this.resolveAccountRow(target, options, result, tx);
    if (!accountId) return;

    if (accountMetadataPatch) {
      await this.patchAccountMetadata(accountId, accountMetadataPatch, tx);
    } else if (preExistingAccountId) {
      // Bump lastSync timestamp on existing rows even when nothing
      // structural changed.
      await tx
        .update(schema.accounts)
        .set({
          metadata: { lastSync: new Date().toISOString() },
          updatedAt: new Date(),
        })
        .where(eq(schema.accounts.id, accountId));
    }

    const holdingsResult = projectSnapshotsToHoldings(snapshots, accountId);
    const snapshotsByExternalId = new Map<string, HoldingSnapshot>();
    for (const s of snapshots) snapshotsByExternalId.set(s.externalId, s);

    const seenExternalIds = new Set(
      holdingsResult.holdings.map((h) => h.externalTokenId || h.symbol)
    );

    for (const holding of holdingsResult.holdings) {
      try {
        if (!holding.symbol || !holding.balance) continue;
        if (!isValidDecimalString(holding.balance)) continue;

        const isZero = parseFloat(holding.balance) === 0;
        if (options.skipZeroBalances && isZero) continue;

        const lookupExternalId =
          holding.contractAddress || holding.externalTokenId || holding.symbol;
        const snapshot =
          snapshotsByExternalId.get(lookupExternalId) ?? snapshotsByExternalId.get(holding.symbol);
        if (!snapshot) {
          this.logger.warn(
            { accountId, holding },
            'No matching snapshot for holding — skipping (provider returned inconsistent shape)'
          );
          continue;
        }

        let tokenMapping = projectSnapshotToTokenMapping(snapshot);
        const tokenTypeId = options.resolveTokenTypeId(snapshot, options.cryptoTokenTypeId);
        const decimals = options.defaultDecimals(snapshot, holding.tokenType);

        if (options.postProcessTokenMapping) {
          tokenMapping = await options.postProcessTokenMapping(
            tokenMapping,
            snapshot,
            holding,
            tokenTypeId,
            tx
          );
        }

        const { token, wasCreated } = await this.tokenService.findOrCreateTokenFromIntegration(
          tokenMapping,
          tokenTypeId,
          decimals,
          tx
        );
        tokenIdSet.add(token.id);

        const externalId = holding.externalTokenId || holding.symbol;
        const existingHolding = await this.holdingRepository.findByAccountTokenAndExternalId(
          accountId,
          token.id,
          externalId,
          options.userId,
          tx,
          true
        );

        if (existingHolding) {
          await this.holdingService.updateHoldingBalanceWithEvent(
            {
              holdingId: existingHolding.id,
              balance: holding.balance,
              eventContext,
            },
            tx
          );

          // If this row was hidden but the upstream now reports a non-zero
          // balance, unhide it so the user sees it on the dashboard again.
          if (existingHolding.isHidden && !isZero) {
            await this.holdingService.updateHoldingWithEvent(
              existingHolding.id,
              { isHidden: false, lastUpdated: new Date() },
              tx
            );
          }

          result.holdings.push({
            id: existingHolding.id,
            accountId,
            accountName: this.findAccountNameInResult(result, accountId, target),
            tokenId: token.id,
            tokenSymbol: token.symbol,
            tokenName: token.name,
            tokenIconUrl: token.iconUrl ?? null,
            tokenIsNew: false,
            tokenScamProbability: token.isScamProbability ?? 0,
            balance: holding.balance,
            externalId: existingHolding.externalId,
            isHidden: existingHolding.isHidden && isZero,
          });
        } else if (!isZero || !options.skipZeroBalances) {
          const newHolding = await this.holdingService.createHoldingWithEvent(
            {
              userId: options.userId,
              accountId,
              tokenId: token.id,
              balance: holding.balance,
              source: options.sourceTag,
              externalId,
              eventContext: options.baseCurrencyId
                ? { baseCurrencyId: options.baseCurrencyId }
                : undefined,
            },
            tx
          );

          result.holdings.push({
            id: newHolding.id,
            accountId,
            accountName: this.findAccountNameInResult(result, accountId, target),
            tokenId: token.id,
            tokenSymbol: token.symbol,
            tokenName: token.name,
            tokenIconUrl: token.iconUrl ?? null,
            tokenIsNew: wasCreated,
            tokenScamProbability: token.isScamProbability ?? 0,
            balance: holding.balance,
            externalId,
            isHidden: false,
          });
        }
      } catch (error) {
        result.errors.push({
          accountInfo,
          error: `Failed to import ${holding.symbol}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }

    if (options.zeroStaleHoldings) {
      try {
        const existingHoldings = await this.holdingRepository.findByAccount(
          accountId,
          tx,
          true,
          true
        );
        for (const eh of existingHoldings) {
          if (eh.source !== options.sourceTag) continue;
          if (eh.externalId && seenExternalIds.has(eh.externalId)) continue;
          if (eh.balance === '0') continue;
          await this.holdingService.updateHoldingBalanceWithEvent(
            {
              holdingId: eh.id,
              balance: '0',
              eventContext,
            },
            tx
          );
        }
      } catch (error) {
        this.logger.warn(
          {
            accountId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to zero stale holdings (non-critical)'
        );
      }
    }
  }

  private async resolveAccountRow(
    target: IntegrationImportTarget,
    options: IntegrationImportOptions,
    result: IntegrationImportResult,
    tx: DatabaseTransaction
  ): Promise<string | null> {
    const { institution, accountInfo, preExistingAccountId, accountName, accountDescription } =
      target;

    if (preExistingAccountId) {
      const [existing] = await tx
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, preExistingAccountId))
        .limit(1);
      if (existing) {
        result.accounts.push({
          id: existing.id,
          name: existing.name,
          institutionId: institution.id,
          institutionName: institution.name,
          accountType: accountInfo.accountType,
          externalId: accountInfo.externalId,
          metadata: (existing.metadata as Record<string, unknown>) ?? {},
        });
        return existing.id;
      }
    }

    const existingAccounts = await tx
      .select()
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.userId, options.userId),
          eq(schema.accounts.institutionId, institution.id)
        )
      );

    // Wallet imports key on (institution, name); exchange/IBKR key on
    // (institution, accountType in metadata). Use accountName when
    // present, else fall back to the metadata.accountType match.
    const keyedExisting = accountName
      ? existingAccounts.find((acc) => acc.name === accountName)
      : existingAccounts.find(
          (acc) =>
            acc.metadata &&
            typeof acc.metadata === 'object' &&
            'accountType' in acc.metadata &&
            (acc.metadata as { accountType?: unknown }).accountType === accountInfo.accountType
        );

    if (keyedExisting) {
      result.accounts.push({
        id: keyedExisting.id,
        name: keyedExisting.name,
        institutionId: institution.id,
        institutionName: institution.name,
        accountType: accountInfo.accountType,
        externalId: accountInfo.externalId,
        metadata: (keyedExisting.metadata as Record<string, unknown>) ?? {},
      });
      return keyedExisting.id;
    }

    const baseMetadata = accountInfo.metadata ?? {};
    const [newAccount] = await tx
      .insert(schema.accounts)
      .values({
        userId: options.userId,
        institutionId: institution.id,
        typeId: target.accountTypeId,
        name: accountName ?? accountInfo.name,
        description: accountDescription ?? accountInfo.description,
        metadata: {
          ...baseMetadata,
          ...(target.accountMetadataPatch ?? {}),
          lastSync: new Date().toISOString(),
        },
        isActive: accountInfo.isActive ?? true,
      })
      .returning();

    if (!newAccount) {
      throw new Error('Failed to create account');
    }

    result.accounts.push({
      id: newAccount.id,
      name: newAccount.name,
      institutionId: institution.id,
      institutionName: institution.name,
      accountType: accountInfo.accountType,
      externalId: accountInfo.externalId,
      metadata: (newAccount.metadata as Record<string, unknown>) ?? {},
    });
    return newAccount.id;
  }

  private async patchAccountMetadata(
    accountId: string,
    patch: Record<string, unknown>,
    tx: DatabaseTransaction
  ): Promise<void> {
    const [existing] = await tx
      .select({ metadata: schema.accounts.metadata })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .limit(1);

    const merged: Record<string, unknown> = {
      ...((existing?.metadata as Record<string, unknown>) ?? {}),
      ...patch,
      lastSync: new Date().toISOString(),
    };

    await tx
      .update(schema.accounts)
      .set({ metadata: merged, updatedAt: new Date() })
      .where(eq(schema.accounts.id, accountId));
  }

  private findAccountNameInResult(
    result: IntegrationImportResult,
    accountId: string,
    target: IntegrationImportTarget
  ): string {
    const found = result.accounts.find((a) => a.id === accountId);
    return found?.name ?? target.accountName ?? target.accountInfo.name;
  }
}

import type { Institution } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { type DatabaseTransaction, withTransaction } from '@scani/db/transaction';
import type { HoldingSnapshot } from '@scani/providers/core/types';
import { type HoldingArrivalAttribution, isValidDecimalString } from '@scani/shared';
import { and, eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { type BalancesAsOf, deriveBalancesAsOf, withBalancesAsOf } from '../../lib/balances-as-of';
import { databaseErrorOf } from '../../lib/database-error';
import { TokenTypeRepository } from '../../repositories/EnumRepositories';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { TokenRepository } from '../../repositories/TokenRepository';
import { BaseService } from '../BaseService';
import { FeedIngestService } from '../feeds/FeedIngestService';
import { FeedInputFollower } from '../feeds/FeedInputFollower';
import { type LegacySnapshot, legacySnapshotBatch } from '../feeds/legacy/snapshot-batch';
import {
  accountChainId,
  providerInputSource,
  walletInputSource,
} from '../foundation/plan-feed-inputs';
import { WALLET_BALANCE_SYNC_SOURCE } from './balance-sync-sources';
import {
  type IntegrationHolding,
  integrationTokenIdentity,
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
  // Stamped on holdings.arrival for rows this import creates. Required for
  // the same reason as on HoldingsSyncHelper: an importer that acquired its
  // snapshots without showing them to anyone must not inherit the answer of
  // one that did (SC-277).
  arrival: HoldingArrivalAttribution;
  // Wallet imports preserve user-deleted holdings; exchange/IBKR zero
  // any holding that the upstream API stops returning.
  zeroStaleHoldings: boolean;
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

interface ImportedHolding {
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

interface ImportedAccount {
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

/**
 * Imports the accounts and balances a connect flow discovered: each account
 * found or created and its metadata patched here, then each answer's balances
 * written as one snapshot batch through `FeedIngestService` (A2 Task 15), in
 * one transaction for every target.
 */
@Service()
export class IntegrationImportService extends BaseService {
  private readonly feedIngest = Container.get(FeedIngestService);
  private readonly feedInputs = Container.get(FeedInputFollower);
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly tokenTypeRepository = Container.get(TokenTypeRepository);

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
        let databaseFailure: { error: unknown } | null = null;
        for (const target of targets) {
          const rowErrors: IntegrationImportResult['errors'] = [];
          try {
            // A savepoint per target, around its account as well as its
            // balances, so a target that fails writes nothing — no account, no
            // fresh `lastSync` over balances that rolled back — and the other
            // targets land (R64).
            const landed = await tx.transaction((sp) =>
              this.processTarget(target, options, rowErrors, sp)
            );
            result.accounts.push(landed.account);
            result.holdings.push(...landed.holdings);
            for (const tokenId of landed.tokenIds) tokenIdSet.add(tokenId);
            result.errors.push(...rowErrors);
          } catch (error) {
            if (databaseFailure === null && databaseErrorOf(error) !== null) {
              databaseFailure = { error };
            }
            result.errors.push(...rowErrors, {
              accountInfo: target.accountInfo,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        // Without savepoints postgres.js remembered a scope's first database
        // error and rejected the import with it at commit, so the job retried.
        // An import that landed nothing still rejects that way rather than
        // reading as a terminal failure the caller will not retry (R66).
        if (result.accounts.length === 0 && databaseFailure !== null) {
          throw databaseFailure.error;
        }
      },
      {
        name: options.transactionName ?? 'integrationImport',
        timeout: options.transactionTimeoutMs ?? 60_000,
      }
    );

    // The connect created these accounts, and ingest their inputs with no
    // credential or wallet: link them now the accounts are committed (R39).
    await this.feedInputs.follow(options.userId, {
      accountIds: result.accounts.map((account) => account.id),
    });

    result.tokenIds = Array.from(tokenIdSet);
    return result;
  }

  /**
   * One target's account and balances. Its per-row errors go to `errors`, the
   * ones known before a failure included; everything else is returned, for the
   * caller to report once the target's savepoint has resolved.
   */
  private async processTarget(
    target: IntegrationImportTarget,
    options: IntegrationImportOptions,
    errors: IntegrationImportResult['errors'],
    tx: DatabaseTransaction
  ): Promise<{ account: ImportedAccount; holdings: ImportedHolding[]; tokenIds: string[] }> {
    const { accountInfo, snapshots, accountMetadataPatch, preExistingAccountId } = target;

    const account = await this.resolveAccountRow(target, options, tx);
    const accountId = account.id;

    // One path rather than two (SC-384). The `preExistingAccountId` branch
    // used to `set({ metadata: { lastSync } })`, which REPLACES the column —
    // so a re-import dropped every other key the account carried, including
    // the as-of this ticket adds. `patchAccountMetadata` reads and merges,
    // which is what "bump lastSync" always meant.
    if (accountMetadataPatch || preExistingAccountId) {
      await this.patchAccountMetadata(
        accountId,
        accountMetadataPatch ?? {},
        deriveBalancesAsOf(snapshots),
        tx
      );
    }

    const projected = projectSnapshotsToHoldings(snapshots, accountId).holdings;
    const { kept, failed } = await this.prepare(projected, snapshots, options, accountId, tx);
    const report = () => {
      for (const { index, error } of failed.sort((a, b) => a.index - b.index)) {
        errors.push({
          accountInfo,
          error: `Failed to import ${projected[index]?.symbol}: ${error}`,
        });
      }
    };

    const batch = legacySnapshotBatch({
      userId: options.userId,
      input: {
        accountId,
        source: this.inputSourceOf(target, options),
        credentialId: null,
        walletId: null,
      },
      returnedAt: snapshots.map((s) => s.capturedAt),
      snapshots: kept.map((k) => k.snapshot),
      absences: [],
      fetchedAt: new Date(),
      options: {
        holdingMatch: 'external-id',
        holdingPolicy: 'create',
        holdingSource: options.sourceTag,
        arrival: options.arrival,
        holdingFailure: 'skip-entry',
        // Every key the provider named, the rows dropped above included, so an
        // asset reported at zero or in a shape that matched no snapshot keeps
        // its old holding.
        absence: options.zeroStaleHoldings
          ? {
              mode: 'immediate',
              guardEmptySnapshot: false,
              reportedKeys: projected.map((h) => h.externalTokenId || h.symbol),
            }
          : null,
        clearsAbsenceTally: false,
        unhideOnNonZero: true,
        unchangedCheckpoint: 'append',
        zeroOpensHolding: true,
      },
    });
    const ingested = await this.feedIngest.ingest(batch, tx).catch((error: unknown) => {
      report();
      throw error;
    });

    const outcomes = ingested.checkpointOutcomes;
    const holdingIds = [...new Set(outcomes.flatMap((o) => o.holdingId ?? []))];
    // Every token resolved, a failed holding's included, in the provider's order.
    const tokenIds = [...new Set(outcomes.flatMap((o) => o.tokenId ?? []))];
    const holdingRows = new Map(
      (await this.holdingRepository.findByIds(holdingIds, tx)).map((h) => [h.id, h])
    );
    const tokenRows = new Map(
      (await this.tokenRepository.findByIds(tokenIds, tx)).map((t) => [t.id, t])
    );
    const holdings: ImportedHolding[] = [];
    for (const [position, { index, holding }] of kept.entries()) {
      const outcome = outcomes[position];
      if (outcome === undefined) continue;
      if (outcome.failure !== null) {
        failed.push({ index, error: outcome.failure });
        continue;
      }
      const row = outcome.holdingId === null ? undefined : holdingRows.get(outcome.holdingId);
      const token = outcome.tokenId === null ? undefined : tokenRows.get(outcome.tokenId);
      if (row === undefined || token === undefined) continue;
      holdings.push({
        id: row.id,
        accountId,
        accountName: account.name,
        tokenId: token.id,
        tokenSymbol: token.symbol,
        tokenName: token.name,
        tokenIconUrl: token.iconUrl ?? null,
        tokenIsNew: false,
        tokenScamProbability: token.isScamProbability ?? 0,
        balance: holding.balance,
        externalId: row.externalId,
        // A hidden row reported at zero stays hidden; ingest shows the rest.
        isHidden: row.isHidden && Number.parseFloat(holding.balance) === 0,
      });
    }
    report();
    return { account, holdings, tokenIds };
  }

  /**
   * The rows of one answer the import keeps, in the provider's order, each
   * with its token identified. A row with no symbol or an unreadable balance,
   * a zero the caller skips, or one that matches no snapshot is dropped; one
   * whose token cannot be identified is reported by its index. A row that
   * reads the database does so in a savepoint, so a database error there costs
   * that row rather than aborting the transaction under every later one (R64,
   * R37's shape).
   */
  private async prepare(
    projected: readonly IntegrationHolding[],
    snapshots: readonly HoldingSnapshot[],
    options: IntegrationImportOptions,
    accountId: string,
    tx: DatabaseTransaction
  ): Promise<{
    kept: Array<{ index: number; holding: IntegrationHolding; snapshot: LegacySnapshot }>;
    failed: Array<{ index: number; error: string }>;
  }> {
    const snapshotsByExternalId = new Map<string, HoldingSnapshot>();
    for (const s of snapshots) snapshotsByExternalId.set(s.externalId, s);
    const typeCodes = new Map<string, string>();
    const kept: Array<{ index: number; holding: IntegrationHolding; snapshot: LegacySnapshot }> =
      [];
    const failed: Array<{ index: number; error: string }> = [];

    for (const [index, holding] of projected.entries()) {
      if (!holding.symbol || !holding.balance) continue;
      if (!isValidDecimalString(holding.balance)) continue;
      if (options.skipZeroBalances && Number.parseFloat(holding.balance) === 0) continue;

      const lookupExternalId = holding.contractAddress || holding.externalTokenId || holding.symbol;
      const snapshot =
        snapshotsByExternalId.get(lookupExternalId) ?? snapshotsByExternalId.get(holding.symbol);
      if (!snapshot) {
        this.logger.warn(
          { accountId, holding },
          'No matching snapshot for holding — skipping (provider returned inconsistent shape)'
        );
        continue;
      }

      try {
        const projectedMapping = projectSnapshotToTokenMapping(snapshot);
        const tokenTypeId = options.resolveTokenTypeId(snapshot, options.cryptoTokenTypeId);
        const prepareRow = async (within: DatabaseTransaction): Promise<LegacySnapshot> => {
          const tokenMapping = options.postProcessTokenMapping
            ? await options.postProcessTokenMapping(
                projectedMapping,
                snapshot,
                holding,
                tokenTypeId,
                within
              )
            : projectedMapping;
          const identity = integrationTokenIdentity(tokenMapping.token);
          return {
            asset: {
              key: holding.externalTokenId || holding.symbol,
              identity,
              typeCode: await this.typeCodeOf(tokenTypeId, typeCodes, within),
              lookup: 'identity',
            },
            balance: holding.balance,
            capturedAt: snapshot.capturedAt,
          };
        };
        // Only a row that can read the database needs the savepoint.
        const prepared =
          options.postProcessTokenMapping || !typeCodes.has(tokenTypeId)
            ? await tx.transaction(prepareRow)
            : await prepareRow(tx);
        kept.push({ index, holding, snapshot: prepared });
      } catch (error) {
        failed.push({ index, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { kept, failed };
  }

  /** The code of a token type the caller named by id, once per import. */
  private async typeCodeOf(
    typeId: string,
    codes: Map<string, string>,
    tx: DatabaseTransaction
  ): Promise<string> {
    const known = codes.get(typeId);
    if (known !== undefined) return known;
    const type = await this.tokenTypeRepository.findById(typeId, tx);
    if (type === null) throw new Error(`No token type has the id ${typeId}`);
    codes.set(typeId, type.code);
    return type.code;
  }

  /** The account's input these balances belong to: its chain's for a wallet, else its provider's (D-7). */
  private inputSourceOf(
    target: IntegrationImportTarget,
    options: IntegrationImportOptions
  ): string {
    if (options.sourceTag !== WALLET_BALANCE_SYNC_SOURCE) {
      return providerInputSource(target.institution.name);
    }
    return walletInputSource(accountChainId(target.accountMetadataPatch));
  }

  private async resolveAccountRow(
    target: IntegrationImportTarget,
    options: IntegrationImportOptions,
    tx: DatabaseTransaction
  ): Promise<ImportedAccount> {
    const { institution, accountInfo, preExistingAccountId, accountName, accountDescription } =
      target;
    const imported = (row: typeof schema.accounts.$inferSelect): ImportedAccount => ({
      id: row.id,
      name: row.name,
      institutionId: institution.id,
      institutionName: institution.name,
      accountType: accountInfo.accountType,
      externalId: accountInfo.externalId,
      metadata: (row.metadata as Record<string, unknown>) ?? {},
    });

    if (preExistingAccountId) {
      const [existing] = await tx
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.id, preExistingAccountId))
        .limit(1);
      if (existing) {
        return imported(existing);
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
      return imported(keyedExisting);
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
          // The as-of lands on the very first import rather than an hour
          // later, on the first scheduled sync — a user who has just
          // connected IBKR and is looking at the numbers is precisely the
          // reader this fact is for.
          ...withBalancesAsOf(
            { ...baseMetadata, ...(target.accountMetadataPatch ?? {}) },
            deriveBalancesAsOf(target.snapshots)
          ),
          lastSync: new Date().toISOString(),
        },
        isActive: accountInfo.isActive ?? true,
      })
      .returning();

    if (!newAccount) {
      throw new Error('Failed to create account');
    }

    return imported(newAccount);
  }

  private async patchAccountMetadata(
    accountId: string,
    patch: Record<string, unknown>,
    asOf: BalancesAsOf | null,
    tx: DatabaseTransaction
  ): Promise<void> {
    const [existing] = await tx
      .select({ metadata: schema.accounts.metadata })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .limit(1);

    const merged: Record<string, unknown> = {
      ...withBalancesAsOf(
        { ...((existing?.metadata as Record<string, unknown>) ?? {}), ...patch },
        asOf
      ),
      lastSync: new Date().toISOString(),
    };

    await tx
      .update(schema.accounts)
      .set({ metadata: merged, updatedAt: new Date() })
      .where(eq(schema.accounts.id, accountId));
  }
}

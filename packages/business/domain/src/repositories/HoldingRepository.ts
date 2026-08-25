import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { Holding, NewHolding, Token } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, asc, eq, gt, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { Service } from 'typedi';
import { SCAM_PROBABILITY_THRESHOLD } from '../lib/constants';

/**
 * Type for holdings with full details including token, account, and institution info
 */
export interface HoldingWithFullDetails {
  holding: Holding;
  token: Token & { typeCode: string; typeName: string };
  account: {
    id: string;
    name: string;
    institutionId: string;
    /** The ownership boundary this account sits in, or null for unassigned
     *  (SC-463). Null is a real state, not a missing one. */
    entityId: string | null;
    typeCode: string;
    typeName: string;
  };
  institution: {
    id: string;
    name: string;
    typeCode: string;
    typeName: string;
    website: string | null;
  };
}

/**
 * The ordering that decides which holding an importer writes into.
 *
 * Exported so `HoldingRepository.test.ts` can assert it directly, and that is
 * not ceremony. Removing this ordering does NOT make the behavioural tests
 * fail: on a two-row fixture Postgres returns the imported row anyway, so the
 * broken query produces the right answer at test scale. It produced the wrong
 * one 25 times out of 73 in production (SC-193). A test that only checks the
 * outcome would have gone green against the very code that caused the bug —
 * so the regression guard has to be on the ordering itself.
 */
export function ingestHoldingOrder() {
  return [
    // `false < true` in Postgres, so rows WITH an externalId — the ones the
    // import side created — sort ahead of the user's manual row.
    sql`${schema.holdings.externalId} is null`,
    asc(schema.holdings.createdAt),
    asc(schema.holdings.id),
  ];
}

@Service()
export class HoldingRepository extends BaseRepository<Holding, NewHolding> {
  protected readonly table = schema.holdings;
  protected readonly tableName = 'holdings';

  // Returns all visible (non-hidden, non-scam) holdings for the user —
  // active AND inactive. Inactive holdings are visible but excluded from
  // totals (see PortfolioValuationService, which filters isActive=true
  // separately).
  async findByUser(
    userId: string,
    transaction?: DatabaseTransaction,
    includeHidden = false
  ): Promise<Holding[]> {
    try {
      const database = this.getDb(transaction);
      const conditions = [
        eq(schema.holdings.userId, userId),
        lt(schema.tokens.isScamProbability, SCAM_PROBABILITY_THRESHOLD),
      ];
      if (!includeHidden) {
        conditions.push(eq(schema.holdings.isHidden, false));
      }
      const whereConditions = and(...conditions);

      const results = await database
        .select({
          holding: schema.holdings,
        })
        .from(schema.holdings)
        .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
        .where(whereConditions)
        .orderBy(schema.holdings.lastUpdated);

      // Return only the holding objects (scam tokens already filtered at database level)
      return results.map((r) => r.holding);
    } catch (error) {
      this.logger.error({ userId, error }, 'Failed to find holdings by user');
      throw error;
    }
  }

  // Cheap probe used by ingest-transactions to detect new holdings
  // created after the last portfolio_value_daily snapshot. Uses a
  // single SQL `LIMIT 1` instead of loading every holding into memory.
  // Backed by `idx_holdings_user_created_at` (migration 0005).
  async hasHoldingCreatedAfter(
    userId: string,
    after: Date,
    transaction?: DatabaseTransaction
  ): Promise<boolean> {
    const database = this.getDb(transaction);
    const [row] = await database
      .select({ id: schema.holdings.id })
      .from(schema.holdings)
      .where(and(eq(schema.holdings.userId, userId), gt(schema.holdings.createdAt, after)))
      .limit(1);
    return Boolean(row);
  }

  async findByAccountAndToken(
    accountId: string,
    tokenId: string,
    userId: string,
    excludeId?: string,
    transaction?: DatabaseTransaction,
    includeHidden = false
  ): Promise<Holding | null> {
    try {
      const database = this.getDb(transaction);

      const conditions = [
        eq(schema.holdings.accountId, accountId),
        eq(schema.holdings.tokenId, tokenId),
        eq(schema.holdings.userId, userId),
      ];

      if (!includeHidden) {
        conditions.push(eq(schema.holdings.isHidden, false));
      }

      if (excludeId) {
        conditions.push(ne(schema.holdings.id, excludeId));
      }

      const results = await database
        .select()
        .from(schema.holdings)
        .where(and(...conditions))
        // `holdings` has no unique constraint on (userId, accountId, tokenId),
        // so this can match more than one row — and until SC-193 it took
        // whichever the plan reached first. Oldest-first, id as the tie-break:
        // the choice matters less than it being the same choice every time.
        .orderBy(asc(schema.holdings.createdAt), asc(schema.holdings.id))
        .limit(1);

      return results[0] || null;
    } catch (error) {
      this.logger.error(
        { accountId, tokenId, userId, excludeId, error },
        'Failed to find holding by account and token'
      );
      throw error;
    }
  }

  /**
   * The unsynced holdings this account already has for any of `tokenIds` —
   * the rows a manual create would duplicate.
   *
   * `external_id IS NULL` is the whole filter, and it is the same line
   * `findByAccountTokenAndExternalId` draws: a synced position carries the
   * key its importer dedupes on, an unsynced one carries nothing. So a
   * manual USD row and an `import_airwallex` USD row in the same account are
   * two positions, not one duplicated — the importer owns its own row and
   * overwrites it on every sync.
   *
   * Unsynced is wider than `source = 'manual'` on purpose: `statement-import`
   * and `ingest-backfill` also write `external_id IS NULL`, and a hand-entered
   * row beside one of those is the same (account, token) duplicate — nothing
   * will ever reconcile the two.
   *
   * Hidden rows count. A hidden holding still owns the (account, token) slot
   * and comes back the moment it is unhidden, so creating a second one beside
   * it produces the duplicate a moment later instead of now.
   */
  async findUnsyncedByAccountAndTokens(
    accountId: string,
    tokenIds: string[],
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<Holding[]> {
    if (tokenIds.length === 0) return [];
    const database = this.getDb(transaction);
    return await database
      .select()
      .from(schema.holdings)
      .where(
        and(
          eq(schema.holdings.accountId, accountId),
          inArray(schema.holdings.tokenId, tokenIds),
          eq(schema.holdings.userId, userId),
          isNull(schema.holdings.externalId)
        )
      );
  }

  /**
   * The holding an importer should attribute a transaction to.
   *
   * Same filter as `findByAccountAndToken`, different preference: a row the
   * import side created outranks one the user maintains by hand.
   *
   * **Why `externalId` and not `source`.** `source` cannot answer this. The tag
   * an import writes is built two incompatible ways — `import_${institution
   * .name}` in `ImportExchangeAccountsUseCase`, a hardcoded `'import_ibkr'` in
   * `ImportIbkrAccountsUseCase`, and `'sync_exchange_balances'` from the
   * balance sync — while the transaction carries a third vocabulary entirely
   * (`airwallex-api`). There is no string equality that holds across those.
   * `externalId` is the key the import side already dedupes on, and
   * `findByAccountTokenAndExternalId` above states the intent this restores:
   * match synced holdings *"without conflicting with manual holdings (which
   * have NULL externalId)"*. That contract existed; the transaction path just
   * never honoured it (SC-193).
   *
   * `IS NULL` sorts after `IS NOT NULL` because `false < true` in Postgres, so
   * imported rows come first and manual rows are the fallback rather than the
   * coin-flip they were.
   *
   * **Why it reads two rows to return one.** The ordering makes the choice
   * deterministic; it does not make the choice safe. Whenever a second row
   * exists, the winner is decided by `externalId`, `createdAt` and `id` — and
   * every one of those can change under the position. Delete the imported row,
   * or null its `externalId`, and the next run resolves to the manual row and
   * re-ingests the entire history onto it, because `holding_tx_dedup` is
   * UNIQUE per HOLDING and has nothing to dedupe against there. That is
   ***REMOVED***
   ***REMOVED***
   * moment the hazard becomes live into a log line naming both candidates.
   * Ambiguity is not an error — production holds legitimately split positions
   * (SC-325) — so it warns and proceeds with the deterministic winner.
   */
  async findForIngest(
    accountId: string,
    tokenId: string,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<Holding | null> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.holdings)
        .where(
          and(
            eq(schema.holdings.accountId, accountId),
            eq(schema.holdings.tokenId, tokenId),
            eq(schema.holdings.userId, userId)
          )
        )
        .orderBy(...ingestHoldingOrder())
        .limit(2);

      if (results.length > 1) {
        const [chosen, runnerUp] = results;
        this.logger.warn(
          {
            accountId,
            tokenId,
            userId,
            chosenHoldingId: chosen?.id,
            chosenSource: chosen?.source,
            chosenExternalId: chosen?.externalId,
            runnerUpHoldingId: runnerUp?.id,
            runnerUpSource: runnerUp?.source,
            runnerUpExternalId: runnerUp?.externalId,
          },
          'Ambiguous ingest holding: (account, token) holds more than one row'
        );
      }

      return results[0] || null;
    } catch (error) {
      this.logger.error(
        { accountId, tokenId, userId, error },
        'Failed to find ingest holding by account and token'
      );
      throw error;
    }
  }

  /**
   * Find a holding by account, token, and external ID.
   * Used by sync/import flows to match synced holdings precisely
   * without conflicting with manual holdings (which have NULL externalId).
   */
  async findByAccountTokenAndExternalId(
    accountId: string,
    tokenId: string,
    externalId: string,
    userId: string,
    transaction?: DatabaseTransaction,
    includeHidden = false
  ): Promise<Holding | null> {
    try {
      const database = this.getDb(transaction);

      const conditions = [
        eq(schema.holdings.accountId, accountId),
        eq(schema.holdings.tokenId, tokenId),
        eq(schema.holdings.externalId, externalId),
        eq(schema.holdings.userId, userId),
      ];

      if (!includeHidden) {
        conditions.push(eq(schema.holdings.isHidden, false));
      }

      const results = await database
        .select()
        .from(schema.holdings)
        .where(and(...conditions))
        .limit(1);

      return results[0] || null;
    } catch (error) {
      this.logger.error(
        { accountId, tokenId, externalId, userId, error },
        'Failed to find holding by account, token, and external ID'
      );
      throw error;
    }
  }

  async findByUserWithFullDetails(
    userId: string,
    accountId?: string,
    transaction?: DatabaseTransaction,
    includeHidden = false,
    includeScamTokens = false
  ): Promise<HoldingWithFullDetails[]> {
    try {
      const database = this.getDb(transaction);

      // Build where conditions
      const conditions = [eq(schema.holdings.userId, userId)];
      if (accountId) {
        conditions.push(eq(schema.holdings.accountId, accountId));
      }
      if (!includeHidden) {
        conditions.push(eq(schema.holdings.isHidden, false));
      }
      // Scam tokens hidden by default — the wallet-import review page passes
      // `includeScamTokens=true` so the operator can still see and act on
      // freshly-flagged holdings.
      if (!includeScamTokens) {
        conditions.push(lt(schema.tokens.isScamProbability, SCAM_PROBABILITY_THRESHOLD));
      }
      const whereConditions = and(...conditions);

      const results = await database
        .select({
          // Holdings data
          holdingId: schema.holdings.id,
          holdingUserId: schema.holdings.userId,
          holdingAccountId: schema.holdings.accountId,
          holdingTokenId: schema.holdings.tokenId,
          holdingBalance: schema.holdings.balance,
          holdingSource: schema.holdings.source,
          holdingArrival: schema.holdings.arrival,
          holdingIsHidden: schema.holdings.isHidden,
          holdingIsActive: schema.holdings.isActive,
          holdingExternalId: schema.holdings.externalId,
          holdingLabel: schema.holdings.label,
          holdingManualEditCause: schema.holdings.manualEditCause,
          holdingLastUpdated: schema.holdings.lastUpdated,
          holdingCreatedAt: schema.holdings.createdAt,
          // Token data with type
          token: schema.tokens,
          tokenTypeCode: schema.tokenTypes.code,
          tokenTypeName: schema.tokenTypes.name,
          // Account data with type
          accountId: schema.accounts.id,
          accountName: schema.accounts.name,
          accountInstitutionId: schema.accounts.institutionId,
          // The ownership boundary (SC-463). Carried on the holdings fetch
          // every valuation already makes, so the per-entity cut costs no
          // second query and cannot resolve membership differently from the
          // list it labels — the mistake SC-385 was about.
          accountEntityId: schema.accounts.entityId,
          accountTypeCode: schema.accountTypes.code,
          accountTypeName: schema.accountTypes.name,
          // Institution data with type
          institutionId: schema.institutions.id,
          institutionName: schema.institutions.name,
          institutionWebsite: schema.institutions.website,
          institutionTypeCode: schema.institutionTypes.code,
          institutionTypeName: schema.institutionTypes.name,
        })
        .from(schema.holdings)
        .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
        .innerJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
        .innerJoin(schema.accounts, eq(schema.holdings.accountId, schema.accounts.id))
        .innerJoin(schema.accountTypes, eq(schema.accounts.typeId, schema.accountTypes.id))
        .innerJoin(schema.institutions, eq(schema.accounts.institutionId, schema.institutions.id))
        .innerJoin(
          schema.institutionTypes,
          eq(schema.institutions.typeId, schema.institutionTypes.id)
        )
        .where(whereConditions);

      return results.map((r) => ({
        holding: {
          id: r.holdingId,
          userId: r.holdingUserId,
          accountId: r.holdingAccountId,
          tokenId: r.holdingTokenId,
          balance: r.holdingBalance,
          label: r.holdingLabel,
          source: r.holdingSource,
          arrival: r.holdingArrival,
          isHidden: r.holdingIsHidden,
          isActive: r.holdingIsActive,
          externalId: r.holdingExternalId,
          manualEditCause: r.holdingManualEditCause,
          lastUpdated: r.holdingLastUpdated,
          createdAt: r.holdingCreatedAt,
        },
        token: {
          ...r.token,
          typeCode: r.tokenTypeCode,
          typeName: r.tokenTypeName,
        },
        account: {
          id: r.accountId,
          name: r.accountName,
          institutionId: r.accountInstitutionId,
          entityId: r.accountEntityId,
          typeCode: r.accountTypeCode,
          typeName: r.accountTypeName,
        },
        institution: {
          id: r.institutionId,
          name: r.institutionName,
          typeCode: r.institutionTypeCode,
          typeName: r.institutionTypeName,
          website: r.institutionWebsite,
        },
      }));
    } catch (error) {
      this.logger.error({ userId, accountId, error }, 'Failed to find holdings with full details');
      throw error;
    }
  }

  /**
   * Find all holdings for a specific account
   * @param accountId - The account ID to find holdings for
   * @param transaction - Optional database transaction
   * @param includeHidden - Whether to include hidden holdings (default: false)
   * @param includeScamTokens - Whether to include tokens marked as potential scams (default: false)
   */
  async findByAccount(
    accountId: string,
    transaction?: DatabaseTransaction,
    includeHidden = false,
    includeScamTokens = false
  ): Promise<Holding[]> {
    try {
      const database = this.getDb(transaction);
      const conditions = [eq(schema.holdings.accountId, accountId)];
      if (!includeScamTokens) {
        conditions.push(lt(schema.tokens.isScamProbability, SCAM_PROBABILITY_THRESHOLD));
      }
      if (!includeHidden) {
        conditions.push(eq(schema.holdings.isHidden, false));
      }
      const whereConditions = and(...conditions);

      const results = await database
        .select({
          holding: schema.holdings,
        })
        .from(schema.holdings)
        .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
        .where(whereConditions);

      // Return only the holding objects (scam tokens already filtered at database level)
      return results.map((r) => r.holding);
    } catch (error) {
      this.logger.error({ accountId, error }, 'Failed to find holdings by account');
      throw error;
    }
  }

  /**
   * Just the ids of this user's holdings, optionally narrowed to one account
   * or one institution (SC-457).
   *
   * Deliberately unfiltered by the inclusion contract. Its only caller
   * (`ReturnsScopeResolver`) feeds the result straight into
   * `PortfolioValueDailyRepository.findIncludedHoldingScopeRange`, which
   * applies hidden / inactive / scam in SQL — applying it twice, in two
   * places, is how the chart and the headline came to disagree in the first
   * place (`isIncludedInTotal`). One gate, and this is not it.
   */
  async findIdsForUser(
    userId: string,
    filter?: { accountId?: string; institutionId?: string },
    transaction?: DatabaseTransaction
  ): Promise<string[]> {
    try {
      const database = this.getDb(transaction);
      const conditions = [eq(schema.holdings.userId, userId)];
      if (filter?.accountId) conditions.push(eq(schema.holdings.accountId, filter.accountId));
      if (filter?.institutionId) {
        conditions.push(eq(schema.accounts.institutionId, filter.institutionId));
      }
      const rows = await database
        .select({ id: schema.holdings.id })
        .from(schema.holdings)
        .innerJoin(schema.accounts, eq(schema.accounts.id, schema.holdings.accountId))
        .where(and(...conditions));
      return rows.map((row) => row.id);
    } catch (error) {
      this.logger.error({ userId, filter, error }, 'Failed to find holding ids for user');
      throw error;
    }
  }

  /**
   * Mark a holding as hidden (soft delete for blockchain holdings)
   */
  async markAsHidden(holdingId: string, transaction?: DatabaseTransaction): Promise<void> {
    try {
      const database = this.getDb(transaction);
      await database
        .update(schema.holdings)
        .set({
          isHidden: true,
        })
        .where(eq(schema.holdings.id, holdingId));
    } catch (error) {
      this.logger.error({ holdingId, error }, 'Failed to mark holding as hidden');
      throw error;
    }
  }

  /**
   * Unhide a holding (restore from hidden state)
   */
  async unhideHolding(holdingId: string, transaction?: DatabaseTransaction): Promise<void> {
    try {
      const database = this.getDb(transaction);
      await database
        .update(schema.holdings)
        .set({
          isHidden: false,
        })
        .where(eq(schema.holdings.id, holdingId));
    } catch (error) {
      this.logger.error({ holdingId, error }, 'Failed to unhide holding');
      throw error;
    }
  }

  /**
   * Visible lookup — default-filters `isHidden=true` rows, matching every
   * dashboard read path. Use this when the caller is showing holdings to
   * the user (holdings list, portfolio value).
   *
   * For raw-row access (e.g. the delete flow that needs to confirm a row
   * exists regardless of hidden state), use the inherited
   * `BaseRepository.findById` instead — that one never filters.
   *
   * Split into two methods (instead of `findById(id, tx, includeHidden?)`)
   * because the old default=false signature silently substituted different
   * semantics into every generic call site, and the LSP violation bit us
   * while writing use-case tests.
   */
  async findByIdVisible(
    holdingId: string,
    transaction?: DatabaseTransaction
  ): Promise<Holding | null> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.holdings)
        .where(and(eq(schema.holdings.id, holdingId), eq(schema.holdings.isHidden, false)))
        .limit(1);
      return results[0] || null;
    } catch (error) {
      this.logger.error({ holdingId, error }, 'Failed to find visible holding by ID');
      throw error;
    }
  }

  /**
   * Update holding balance
   */
  async updateBalance(
    holdingId: string,
    balance: string,
    transaction?: DatabaseTransaction
  ): Promise<void> {
    try {
      const database = this.getDb(transaction);
      await database
        .update(schema.holdings)
        .set({
          balance,
          lastUpdated: new Date(),
        })
        .where(eq(schema.holdings.id, holdingId));
    } catch (error) {
      this.logger.error({ holdingId, balance, error }, 'Failed to update holding balance');
      throw error;
    }
  }

  /**
   * Delete a holding by ID
   */
  async deleteById(holdingId: string, transaction?: DatabaseTransaction): Promise<void> {
    try {
      const database = this.getDb(transaction);
      await database.delete(schema.holdings).where(eq(schema.holdings.id, holdingId));
    } catch (error) {
      this.logger.error({ holdingId, error }, 'Failed to delete holding');
      throw error;
    }
  }

  /**
   * Get distinct token IDs from all holdings that we actually need prices for.
   * Excludes hidden holdings and scam tokens; includes inactive holdings
   * because inactive holdings are still displayed to the user (just not
   * counted in totals) and therefore need prices.
   */
  async getDistinctTokenIds(transaction?: DatabaseTransaction): Promise<string[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .selectDistinct({ tokenId: schema.holdings.tokenId })
        .from(schema.holdings)
        .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
        .where(
          and(
            eq(schema.holdings.isHidden, false),
            lt(schema.tokens.isScamProbability, SCAM_PROBABILITY_THRESHOLD)
          )
        );

      return results.map((row) => row.tokenId);
    } catch (error) {
      this.logger.error({ error }, 'Failed to get distinct token IDs');
      throw error;
    }
  }
}

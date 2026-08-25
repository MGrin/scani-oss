import type { DatabaseTransaction } from '@scani/db';
import type { Holding } from '@scani/db/schema';
import type { CreateHoldingInput, HoldingArrivalAttribution } from '@scani/shared';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { AccountRepository } from '../../repositories/AccountRepository';
import { HoldingBalanceObservationRepository } from '../../repositories/HoldingBalanceObservationRepository';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { BaseService } from '../BaseService';

/**
 * Input for creating a holding with full context for event tracking
 */
export interface CreateHoldingWithEventInput {
  accountId: string;
  tokenId: string;
  balance: string;
  userId: string;
  source?: string;
  // Required rather than defaulted: every caller knows whether a human
  // picked this position, and a default would let the one that never
  // thought about it inherit `unattributed` while looking deliberate.
  arrival: HoldingArrivalAttribution;
  externalId?: string; // Exchange-specific identifier for synced holdings
  // What the user calls this pot, when one account holds several rows for one
  // token (SC-330). Importers leave it null — they address a position by
  // `externalId`, and a name is a thing only a human can supply.
  label?: string | null;
  lastUpdated?: Date;
  // Event context (optional - if not provided, events won't be created)
  eventContext?: {
    baseCurrencyId: string;
    price?: string; // If not provided, will use "0"
  };
  // Suppress the create-time sync-capture observation. Use when the caller
  // is about to call `updateHoldingBalance` with the real balance: writing
  // a placeholder 0 obs and then a real obs <50ms later produces two rows
  // with the same `observed_at` second, and `findLatestAtOrAfter` (used by
  // BalanceAtTimeService) picks the earlier one — anchoring all past-date
  // reconstructions on the bogus 0. File-import is the canonical case.
  skipSyncCapture?: boolean;
}

/**
 * The person said what this balance change was, at the moment they made it
 * (SC-606).
 *
 * Stamped into the observation's OWN insert rather than updated onto it a
 * moment later, so there is never an instant where the row exists unanswered:
 * `BalanceGapService.listPending` is computed on read, and a queue read
 * landing in that window would show a gap the user has already explained.
 *
 * The value is a `BalanceGapAnswer` — the same vocabulary the queue writes,
 * because SC-501 already made `BALANCE_GAP_ANSWERS` `MANUAL_EDIT_CAUSES` plus
 * `unknown` precisely so the two paths could not drift. `gapReviewSource` is
 * always `'user'`: nothing else may claim this, since the whole content of the
 * marker is that a person was present and spoke.
 */
export interface BalanceObservationAttestation {
  /** What they said it was. A `BalanceGapAnswer`, not a free string. */
  answer: string;
  /** When they said it. Defaults to the observation's own instant. */
  at?: Date;
}

/**
 * Input for updating a holding balance with event tracking
 */
export interface UpdateHoldingBalanceInput {
  holdingId: string;
  balance: string;
  // Event context (optional - if not provided, events won't be created)
  eventContext?: {
    userId: string;
    baseCurrencyId: string;
    price?: string;
  };
}

// HoldingService — all holding *mutations*. Reads live in
// HoldingQueryService.
@Service()
export class HoldingService extends BaseService {
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly accountRepository = Container.get(AccountRepository);
  // Every balance mutation appends a 'sync-capture' observation, giving
  // the historical-PnL subsystem a forward-history floor for every account
  // whether or not a transaction-ingester is wired for its source.
  //
  // That sentence was false for two years, in exactly one place, and the
  // comment is why nobody looked: `UpdateHoldingUseCase` — the only path a
  // user can edit a MANUAL holding's balance through — wrote the table
  // directly and never reached this service. Measured on production
  ***REMOVED***
  ***REMOVED***
  // partition along the one write path that skipped the service (SC-245).
  //
  // `recordBalanceObservation` below is public so that path can satisfy
  // the invariant without duplicating it. The invariant is still
  // convention rather than enforcement — nothing stops the next caller
  // writing `holdings` directly — but there is now exactly one
  // implementation of it to call.
  private readonly observationRepository = Container.get(HoldingBalanceObservationRepository);

  constructor() {
    super('HoldingService');
  }

  // Append a sync-capture balance observation. Best-effort — any failure
  // must NOT cause the originating holding mutation to fail, because the
  // observation table is a pure additive side effect.
  //
  // The dedup key is (holding, observed_at, source); using a fresh Date
  // per call means we rarely collide in practice. On the off-chance of a
  // sub-millisecond collision, the unique constraint turns the second
  // write into a no-op and we log-and-continue.
  //
  // Public because callers that must scope their own write by `userId`
  // cannot go through `updateHoldingBalance`, which keys on `holdingId`
  // alone. They do the ownership-scoped update themselves and then call
  // this with the row it returned — no second round-trip, and no second
  // copy of the observation logic (SC-245).
  async recordBalanceObservation(
    holding: { id: string; userId: string; accountId: string; tokenId: string; balance: string },
    transaction?: DatabaseTransaction,
    meta?: Record<string, unknown>,
    attestation?: BalanceObservationAttestation
  ): Promise<void> {
    try {
      const now = new Date();
      await this.observationRepository.append(
        {
          userId: holding.userId,
          holdingId: holding.id,
          balance: holding.balance,
          observedAt: now,
          source: 'sync-capture',
          sourceMetadata: meta ?? {},
          ...(attestation
            ? {
                gapReview: attestation.answer,
                gapReviewSource: 'user',
                gapReviewedAt: attestation.at ?? now,
              }
            : {}),
        },
        transaction
      );
    } catch (error) {
      this.logger.warn(
        {
          accountId: holding.accountId,
          tokenId: holding.tokenId,
          error: error instanceof Error ? error.message : error,
        },
        'Failed to append sync-capture observation (non-fatal)'
      );
    }
  }

  // ============================================
  // HOLDING MUTATIONS (with event tracking)
  // ============================================

  /**
   * Create a single holding with optional event tracking
   * Use this for user-initiated holding creation
   */
  async createHolding(data: CreateHoldingInput, userId: string): Promise<Holding> {
    try {
      this.logDebug('Creating holding', {
        accountId: data.accountId,
        tokenId: data.tokenId,
        balance: data.balance,
      });

      this.validateRequiredFields(data, ['accountId', 'tokenId', 'balance']);

      // Validate balance
      const balance = new Decimal(data.balance);
      if (balance.isNegative()) {
        throw new Error('Balance cannot be negative');
      }

      // Verify account exists and belongs to user
      const account = await this.accountRepository.findById(data.accountId);
      this.assertExists(account, `Account with ID ${data.accountId} not found`);

      if (account.userId !== userId) {
        throw new Error('Unauthorized: Account does not belong to user');
      }

      // Create the holding (multiple holdings of same token in same account are allowed)
      const holding = await this.holdingRepository.create({
        accountId: data.accountId,
        tokenId: data.tokenId,
        balance: data.balance,
        userId,
        lastUpdated: data.lastUpdated || new Date(),
      });

      this.assertExists(holding, 'Failed to create holding');

      await this.recordBalanceObservation(
        {
          id: holding.id,
          userId,
          accountId: data.accountId,
          tokenId: data.tokenId,
          balance: data.balance,
        },
        undefined,
        { origin: 'createHolding' }
      );

      this.logDebug('Holding created successfully', { holdingId: holding.id });
      return holding;
    } catch (error) {
      throw this.handleError(error, 'createHolding');
    }
  }

  /**
   * Create a holding with full event context
   * This is the preferred method for sync/import operations
   */
  async createHoldingWithEvent(
    input: CreateHoldingWithEventInput,
    transaction?: DatabaseTransaction
  ): Promise<Holding> {
    try {
      // Create the holding (multiple same-token holdings per account are allowed)
      const holding = await this.holdingRepository.create(
        {
          accountId: input.accountId,
          tokenId: input.tokenId,
          balance: input.balance,
          userId: input.userId,
          source: input.source || 'manual',
          arrival: input.arrival,
          externalId: input.externalId || null,
          label: input.label || null,
          lastUpdated: input.lastUpdated || new Date(),
        },
        transaction
      );
      if (!input.skipSyncCapture) {
        await this.recordBalanceObservation(
          {
            id: holding.id,
            userId: input.userId,
            accountId: input.accountId,
            tokenId: input.tokenId,
            balance: input.balance,
          },
          transaction,
          { origin: 'createHoldingWithEvent', source: input.source ?? 'manual' }
        );
      }
      this.logDebug('Holding created', { holdingId: holding.id });
      return holding;
    } catch (error) {
      throw this.handleError(error, 'createHoldingWithEvent');
    }
  }

  /**
   * Create multiple holdings (batch operation)
   * Events are created for each holding if eventContext is provided in individual items
   */
  async createManyHoldings(
    data: CreateHoldingInput[],
    userId: string,
    tx?: DatabaseTransaction
  ): Promise<Holding[]> {
    try {
      this.logDebug('Creating multiple holdings', { count: data.length });

      const createdHoldings: Holding[] = await this.holdingRepository.createMany(
        data.map((holdingInput) => ({
          ...holdingInput,
          userId,
        })),
        tx
      );

      this.logDebug('Multiple holdings created successfully', {
        count: createdHoldings.length,
      });
      return createdHoldings;
    } catch (error) {
      throw this.handleError(error, 'createManyHoldings');
    }
  }

  /**
   * Create multiple holdings with event tracking
   * Use this for bulk imports that need event tracking
   */
  async createManyHoldingsWithEvents(
    inputs: CreateHoldingWithEventInput[],
    transaction?: DatabaseTransaction
  ): Promise<Holding[]> {
    try {
      this.logDebug('Creating multiple holdings with events', {
        count: inputs.length,
      });

      const holdings: Holding[] = [];
      for (const input of inputs) {
        const holding = await this.createHoldingWithEvent(input, transaction);
        holdings.push(holding);
      }

      this.logDebug('Multiple holdings with events created', {
        count: holdings.length,
      });
      return holdings;
    } catch (error) {
      throw this.handleError(error, 'createManyHoldingsWithEvents');
    }
  }

  /**
   * Update holding balance with optional event tracking
   */
  async updateHoldingBalance(
    holdingId: string,
    balance: string,
    transaction?: DatabaseTransaction
  ): Promise<void> {
    try {
      await this.holdingRepository.updateBalance(holdingId, balance, transaction);
      // Look up the holding post-update to get the userId/accountId/tokenId
      // we need for the observation. One extra round-trip — acceptable
      // given this path is called from sync jobs that already spend
      // serious time per holding.
      const holding = await this.holdingRepository.findById(holdingId, transaction);
      if (holding) {
        await this.recordBalanceObservation(
          {
            id: holding.id,
            userId: holding.userId,
            accountId: holding.accountId,
            tokenId: holding.tokenId,
            balance,
          },
          transaction,
          { origin: 'updateHoldingBalance' }
        );
      }
    } catch (error) {
      throw this.handleError(error, 'updateHoldingBalance');
    }
  }

  /**
   * Update holding balance with event tracking
   * This is the preferred method for sync operations that need event tracking
   */
  async updateHoldingBalanceWithEvent(
    input: UpdateHoldingBalanceInput,
    transaction?: DatabaseTransaction
  ): Promise<void> {
    try {
      // Get holding details for event
      const holding = await this.holdingRepository.findById(input.holdingId, transaction);
      if (!holding) {
        throw new Error(`Holding not found: ${input.holdingId}`);
      }

      // Update the balance
      await this.holdingRepository.updateBalance(input.holdingId, input.balance, transaction);
      await this.recordBalanceObservation(
        {
          id: holding.id,
          userId: holding.userId,
          accountId: holding.accountId,
          tokenId: holding.tokenId,
          balance: input.balance,
        },
        transaction,
        { origin: 'updateHoldingBalanceWithEvent' }
      );
    } catch (error) {
      throw this.handleError(error, 'updateHoldingBalanceWithEvent');
    }
  }

  /**
   * Update holding fields (balance, isActive, isHidden, etc.)
   */
  async updateHolding(
    holdingId: string,
    updates: Partial<Pick<Holding, 'balance' | 'isActive' | 'isHidden' | 'lastUpdated'>>,
    transaction?: DatabaseTransaction
  ): Promise<Holding | null> {
    try {
      return await this.holdingRepository.update(holdingId, updates, transaction);
    } catch (error) {
      throw this.handleError(error, 'updateHolding');
    }
  }

  /**
   * Update holding fields. Originally named `WithEvent` because this was
   * going to emit portfolio events — that wiring never landed and the
   * name was a lie. Kept as a lightweight wrapper over the repository
   * update that surfaces the "not found" case as an error (important
   * for sync paths that must abort on missing rows).
   */
  async updateHoldingWithEvent(
    holdingId: string,
    updates: Partial<Pick<Holding, 'balance' | 'isActive' | 'isHidden' | 'lastUpdated'>>,
    transaction?: DatabaseTransaction
  ): Promise<Holding | null> {
    try {
      const updated = await this.holdingRepository.update(holdingId, updates, transaction);
      if (!updated) {
        throw new Error(`Holding not found: ${holdingId}`);
      }
      return updated;
    } catch (error) {
      throw this.handleError(error, 'updateHoldingWithEvent');
    }
  }

  /**
   * Delete holding (hard delete)
   */
  async deleteHolding(holdingId: string, transaction?: DatabaseTransaction): Promise<void> {
    try {
      this.logDebug('Deleting holding', { holdingId });
      await this.holdingRepository.deleteById(holdingId, transaction);
    } catch (error) {
      throw this.handleError(error, 'deleteHolding');
    }
  }

  /**
   * Delete holding with event tracking
   */
  async deleteHoldingWithEvent(
    holdingId: string,
    transaction?: DatabaseTransaction
  ): Promise<void> {
    try {
      await this.holdingRepository.deleteById(holdingId, transaction);
      this.logDebug('Holding deleted', { holdingId });
    } catch (error) {
      throw this.handleError(error, 'deleteHoldingWithEvent');
    }
  }

  /**
   * Hide holding (soft delete for blockchain holdings)
   */
  async hideHolding(holdingId: string, transaction?: DatabaseTransaction): Promise<void> {
    try {
      await this.holdingRepository.markAsHidden(holdingId, transaction);
    } catch (error) {
      throw this.handleError(error, 'hideHolding');
    }
  }

  /**
   * Hide holding with event tracking
   */
  async hideHoldingWithEvent(holdingId: string, transaction?: DatabaseTransaction): Promise<void> {
    try {
      await this.holdingRepository.markAsHidden(holdingId, transaction);
      this.logDebug('Holding hidden', { holdingId });
    } catch (error) {
      throw this.handleError(error, 'hideHoldingWithEvent');
    }
  }

  /**
   * Unhide/restore a holding
   */
  async unhideHolding(holdingId: string, transaction?: DatabaseTransaction): Promise<void> {
    try {
      await this.holdingRepository.unhideHolding(holdingId, transaction);
    } catch (error) {
      throw this.handleError(error, 'unhideHolding');
    }
  }

  /**
   * Unhide/restore a holding with event tracking
   */
  async unhideHoldingWithEvent(
    holdingId: string,
    transaction?: DatabaseTransaction
  ): Promise<Holding | null> {
    try {
      await this.holdingRepository.unhideHolding(holdingId, transaction);
      this.logDebug('Holding unhidden', { holdingId });
      return await this.holdingRepository.findById(holdingId, transaction);
    } catch (error) {
      throw this.handleError(error, 'unhideHoldingWithEvent');
    }
  }

  // Ingester-side helper: find the holding for (user, account, token),
  // or create a balance=0 row when an ingester sees a token the user
  // historically traded but no longer holds. The zero-balance row gives
  // the ledger an anchor for tx attribution on fully-sold or delisted
  // positions; the UI shows them with "0" balance and a full tx history.
  //
  // The "find" half goes through `findForIngest`, which prefers a row
  // the import side created (`externalId IS NOT NULL`) over one the
  // user maintains by hand, then orders oldest-first.
  //
  // Both halves of that sentence used to be wrong, and the comment was
  // what kept the bug from being found (SC-193). It claimed "newest row
  // wins", which described a tie-break the query did not have — there
  // was no ORDER BY at all, so a `.limit(1)` over two matching rows took
  // whichever the plan reached first. And it claimed this helper "only
  // triggers for tokens the balance sync didn't return — historical-only
  // positions where there's exactly one row per (account, token) by
  // definition", which is false exactly when the balance importer has
  // already created its own `externalId`-keyed row for that token. That
  // is not an edge case: it is the shape of every integration that
  // imports balances and transactions both.
  //
  // What it cost: 73 Airwallex transactions split 48/25 across two USD
  // holdings in one account over the same window, the majority landing
  // on the row marked `manual`. `TransactionRouter` memoises the
  // resolution per run, so each run was internally consistent and
  // different runs disagreed — which is why it reads as two blocks
  // rather than as noise.
  /**
   * Read-only sibling of `findOrCreateForIngest`. Returns the existing
   * holding for `(account, token)` or `null`. Used by the wallet
   * tx-import path so that transactions referencing tokens the user
   * didn't keep during the wallet-import review get skipped instead of
   * silently re-introducing the (often spam) token. Exchange tx-import
   * still uses the create-on-miss flavour because exchange holdings
   * aren't gated by a review step.
   */
  async findExistingForIngest(
    input: { userId: string; accountId: string; tokenId: string },
    transaction?: DatabaseTransaction
  ): Promise<Holding | null> {
    return this.holdingRepository.findForIngest(
      input.accountId,
      input.tokenId,
      input.userId,
      transaction
    );
  }

  async findOrCreateForIngest(
    input: { userId: string; accountId: string; tokenId: string },
    transaction?: DatabaseTransaction
  ): Promise<Holding> {
    // includeHidden is implicit: `findForIngest` does not filter on
    // `isHidden`, because an ingester needs the row even if the user hid it.
    const existing = await this.holdingRepository.findForIngest(
      input.accountId,
      input.tokenId,
      input.userId,
      transaction
    );
    if (existing) return existing;

    // Create with balance=0 so the ledger has an anchor. Source is
    // 'ingest-backfill' (NOT 'manual') so subsequent balance syncs
    // don't mistake this for user-entered data and overwrite in ways
    // the sync flow isn't prepared for.
    const created = await this.holdingRepository.create(
      {
        userId: input.userId,
        accountId: input.accountId,
        tokenId: input.tokenId,
        balance: '0',
        source: 'ingest-backfill',
        externalId: null,
        lastUpdated: new Date(),
      },
      transaction
    );
    if (!created) {
      throw new Error(
        `findOrCreateForIngest: could not create holding for (${input.accountId}, ${input.tokenId})`
      );
    }
    return created;
  }
}

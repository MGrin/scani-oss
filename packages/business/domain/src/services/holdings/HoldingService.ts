import type { DatabaseTransaction } from '@scani/db';
import type { Holding } from '@scani/db/schema';
import type { CreateHoldingInput } from '@scani/shared';
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
  externalId?: string; // Exchange-specific identifier for synced holdings
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
  private readonly observationRepository = Container.get(HoldingBalanceObservationRepository);

  constructor() {
    super('HoldingService');
  }

  // Append a sync-capture balance observation. Best-effort — any failure
  // must NOT cause the originating holding mutation to fail, because the
  // observation table is a pure additive side effect.
  //
  // The dedup key is (account, token, observed_at, source); using a
  // fresh Date per call means we rarely collide in practice. On the
  // off-chance of a sub-millisecond collision, the unique constraint
  // turns the second write into a no-op and we log-and-continue.
  private async appendSyncCaptureObservation(
    holding: { id: string; userId: string; accountId: string; tokenId: string; balance: string },
    transaction?: DatabaseTransaction,
    meta?: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.observationRepository.append(
        {
          userId: holding.userId,
          holdingId: holding.id,
          balance: holding.balance,
          observedAt: new Date(),
          source: 'sync-capture',
          sourceMetadata: meta ?? {},
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

      await this.appendSyncCaptureObservation(
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
          externalId: input.externalId || null,
          lastUpdated: input.lastUpdated || new Date(),
        },
        transaction
      );
      if (!input.skipSyncCapture) {
        await this.appendSyncCaptureObservation(
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
        await this.appendSyncCaptureObservation(
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
      await this.appendSyncCaptureObservation(
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
  // The "find" half relies on the standard repo lookup (newest row
  // wins) because `holdings` has no unique constraint on
  // (userId, accountId, tokenId). The balance-import path keeps its own
  // `externalId` key for dedup; this helper only triggers for tokens
  // the balance sync didn't return — historical-only positions where
  // there's exactly one row per (account, token) by definition.
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
    return this.holdingRepository.findByAccountAndToken(
      input.accountId,
      input.tokenId,
      input.userId,
      undefined,
      transaction,
      true
    );
  }

  async findOrCreateForIngest(
    input: { userId: string; accountId: string; tokenId: string },
    transaction?: DatabaseTransaction
  ): Promise<Holding> {
    const existing = await this.holdingRepository.findByAccountAndToken(
      input.accountId,
      input.tokenId,
      input.userId,
      undefined, // excludeId
      transaction,
      true // includeHidden — ingester needs the row even if user hid it
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

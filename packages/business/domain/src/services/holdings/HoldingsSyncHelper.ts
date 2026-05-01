// HoldingsSyncHelper — shared per-snapshot create/update routine for the wallet + exchange sync use cases.

import type { Account, Holding } from '@scani/db/schema';
import type { DatabaseTransaction } from '@scani/db/transaction';
import type { HoldingSnapshot } from '@scani/providers/core/types';
import { isValidDecimalString } from '@scani/shared';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { BaseService } from '../BaseService';
import { TokenService } from '../tokens/TokenService';
import { HoldingService } from './HoldingService';
import {
  type IntegrationHolding,
  projectSnapshotsToHoldings,
  projectSnapshotToTokenMapping,
} from './HoldingSnapshotProjection';

export type DedupStrategy = 'externalId' | 'tokenId';
export type StaleStrategy = 'preserve' | 'zero';

export interface ProcessSnapshotsForAccountInput {
  account: Pick<Account, 'id' | 'userId'>;
  userId: string;
  userBaseCurrencyId: string | null;
  snapshots: HoldingSnapshot[];
  cryptoTokenTypeId: string;
  tokenTypeMap: Record<string, string>;
  existingHoldings: Holding[];
  staleStrategy: StaleStrategy;
  dedupStrategy: DedupStrategy;
  sourceTag: string;
  defaultDecimals: number;
  // Wallet sync preserves user-hidden state across counts; exchange sync
  // counts every mutation regardless. Set true for wallet-style behaviour.
  respectHiddenForCounts: boolean;
  // Exchange sync skips updates when the balance hasn't changed; wallet
  // sync updates unconditionally to refresh the lastUpdated timestamp.
  skipUnchangedUpdates: boolean;
  // Recurring wallet syncs (`wallet-balances` cron) set this to true so
  // they only refresh balances on holdings the user already chose to
  // keep — never auto-create new ones from chain discovery. The
  // user-initiated wallet-import flow has its own review step
  // (`walletImport.confirmHoldings`) for adding tokens; the cron must
  // not silently re-import tokens the user explicitly excluded.
  updateOnly: boolean;
  tx: DatabaseTransaction;
}

export interface ProcessSnapshotsForAccountResult {
  updated: number;
  created: number;
  removed: number;
}

@Service()
export class HoldingsSyncHelper extends BaseService {
  private readonly holdingService = Container.get(HoldingService);
  private readonly tokenService = Container.get(TokenService);

  constructor() {
    super('HoldingsSyncHelper');
  }

  async processSnapshotsForAccount(
    input: ProcessSnapshotsForAccountInput
  ): Promise<ProcessSnapshotsForAccountResult> {
    const {
      account,
      userId,
      userBaseCurrencyId,
      snapshots,
      cryptoTokenTypeId,
      tokenTypeMap,
      existingHoldings,
      staleStrategy,
      dedupStrategy,
      sourceTag,
      defaultDecimals,
      respectHiddenForCounts,
      updateOnly,
      skipUnchangedUpdates,
      tx,
    } = input;

    let updated = 0;
    let created = 0;
    let removed = 0;

    const snapshotsByExternalId = new Map<string, HoldingSnapshot>();
    for (const s of snapshots) snapshotsByExternalId.set(s.externalId, s);

    const projection = projectSnapshotsToHoldings(snapshots, account.id);

    const existingByCompositeKey = new Map<string, Holding>();
    const existingByTokenId = new Map<string, Holding>();
    for (const h of existingHoldings) {
      existingByTokenId.set(h.tokenId, h);
      const compositeKey = h.externalId ? `${h.tokenId}:${h.externalId}` : h.tokenId;
      existingByCompositeKey.set(compositeKey, h);
    }

    const seenTokenIds = new Set<string>();
    const eventContext = userBaseCurrencyId
      ? { userId, baseCurrencyId: userBaseCurrencyId }
      : undefined;

    for (const integrationHolding of projection.holdings) {
      try {
        if (!integrationHolding.symbol || !integrationHolding.balance) {
          this.logger.warn(
            { accountId: account.id, holding: integrationHolding },
            'Skipping integration holding with missing symbol or balance'
          );
          continue;
        }

        if (!isValidDecimalString(integrationHolding.balance)) {
          this.logger.warn(
            { accountId: account.id, holding: integrationHolding },
            'Skipping integration holding with invalid balance format'
          );
          continue;
        }

        const lookupExternalId = pickExternalLookupKey(integrationHolding);
        const snapshot =
          snapshotsByExternalId.get(lookupExternalId) ??
          snapshotsByExternalId.get(integrationHolding.symbol);
        if (!snapshot) {
          this.logger.warn(
            { accountId: account.id, holding: integrationHolding },
            'No matching snapshot for holding — skipping (provider returned inconsistent shape)'
          );
          continue;
        }

        const tokenMapping = projectSnapshotToTokenMapping(snapshot);
        const resolvedTokenTypeId =
          tokenTypeMap[integrationHolding.tokenType ?? 'crypto'] ?? cryptoTokenTypeId;

        const { token } = await this.tokenService.findOrCreateTokenFromIntegration(
          tokenMapping,
          resolvedTokenTypeId,
          defaultDecimals,
          tx
        );

        seenTokenIds.add(token.id);

        const existing = this.findExisting({
          dedupStrategy,
          token,
          lookupExternalId,
          existingByCompositeKey,
          existingByTokenId,
        });

        const balance = integrationHolding.balance;
        const isZero = new Decimal(balance).isZero();
        const wasHidden = existing?.isHidden ?? false;

        if (existing) {
          if (skipUnchangedUpdates && existing.balance === balance) continue;

          await this.holdingService.updateHoldingBalanceWithEvent(
            { holdingId: existing.id, balance, eventContext },
            tx
          );

          if (respectHiddenForCounts && wasHidden) continue;
          if (isZero) removed++;
          else updated++;
        } else if (!isZero && !updateOnly) {
          await this.holdingService.createHoldingWithEvent(
            {
              userId,
              accountId: account.id,
              tokenId: token.id,
              balance,
              source: sourceTag,
              externalId: dedupStrategy === 'externalId' ? lookupExternalId : undefined,
              eventContext: eventContext
                ? { baseCurrencyId: eventContext.baseCurrencyId }
                : undefined,
            },
            tx
          );
          created++;
        }
      } catch (error) {
        this.logger.error(
          {
            accountId: account.id,
            symbol: integrationHolding.symbol,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to process integration holding'
        );
      }
    }

    if (staleStrategy === 'zero') {
      for (const [tokenId, existing] of existingByTokenId) {
        if (seenTokenIds.has(tokenId)) continue;
        if (existing.balance === '0') continue;
        // Manual rows are user-curated — exchange sync must not zero them
        // even when the upstream API stops returning the token.
        if (existing.source === 'manual') continue;
        try {
          await this.holdingService.updateHoldingBalanceWithEvent(
            { holdingId: existing.id, balance: '0', eventContext },
            tx
          );
          removed++;
        } catch (error) {
          this.logger.error(
            {
              holdingId: existing.id,
              error: error instanceof Error ? error.message : String(error),
            },
            'Failed to zero out stale holding'
          );
        }
      }
    }

    return { updated, created, removed };
  }

  private findExisting(input: {
    dedupStrategy: DedupStrategy;
    token: { id: string };
    lookupExternalId: string;
    existingByCompositeKey: Map<string, Holding>;
    existingByTokenId: Map<string, Holding>;
  }): Holding | undefined {
    const { dedupStrategy, token, lookupExternalId, existingByCompositeKey, existingByTokenId } =
      input;
    if (dedupStrategy === 'tokenId') return existingByTokenId.get(token.id);
    const compositeKey = `${token.id}:${lookupExternalId}`;
    return existingByCompositeKey.get(compositeKey) ?? existingByTokenId.get(token.id);
  }
}

function pickExternalLookupKey(holding: IntegrationHolding): string {
  return holding.contractAddress || holding.externalTokenId || holding.symbol;
}

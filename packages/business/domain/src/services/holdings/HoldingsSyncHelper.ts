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
  // When true, only existing holdings are refreshed — no new holdings are
  // created from snapshots. The `wallet-balances` cron sets this false so
  // it auto-discovers newly-received tokens; callers that filter snapshots
  // up-front (e.g. against `holding_exclusions`) keep deliberately-rejected
  // tokens out before they reach the helper.
  updateOnly: boolean;
  tx: DatabaseTransaction;
}

export interface ProcessSnapshotsForAccountResult {
  updated: number;
  created: number;
  removed: number;
  // Token id of every holding created this run. NOTE: this is the
  // holding's token — which may be a pre-existing, shared token row
  // (findOrCreateTokenFromIntegration returns the existing row when a
  // wallet receives an already-known token). Callers that scam-score
  // or otherwise mutate the token MUST re-check the token is genuinely
  // new before writing — see SyncWalletBalancesUseCase.scoreAndWarmNewTokens.
  createdTokenIds: string[];
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
    const createdTokenIds: string[] = [];

    const snapshotsByExternalId = new Map<string, HoldingSnapshot>();
    for (const s of snapshots) snapshotsByExternalId.set(s.externalId, s);

    const projection = projectSnapshotsToHoldings(snapshots, account.id);

    // Manual holdings are user-curated. An automated balance sync must never
    // adopt one as its own row — neither to update nor to zero it. Excluding
    // them from the reconciliation maps keeps the sync blind to manual rows,
    // so it only ever touches the holdings it owns (and creates its own row
    // when a token happens to be held only manually). Without this, two
    // holdings sharing a token (a synced one plus a manual one) collide in
    // existingByTokenId and the sync silently overwrites the manual balance.
    const existingByCompositeKey = new Map<string, Holding>();
    const existingByTokenId = new Map<string, Holding>();
    for (const h of existingHoldings) {
      if (h.source === 'manual') continue;
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
          createdTokenIds.push(token.id);
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

    return { updated, created, removed, createdTokenIds };
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

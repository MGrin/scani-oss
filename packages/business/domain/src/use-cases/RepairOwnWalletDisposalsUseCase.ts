import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import type { TransferDestinationRef } from '@scani/shared';
import { txHashFromPayload } from '@scani/shared';
import Decimal from 'decimal.js';
import { and, eq, sql } from 'drizzle-orm';
import Container, { Service } from 'typedi';
import type { OwnWalletDisposal } from '../services/TransferReviewService';
import { TransferReviewService } from '../services/TransferReviewService';

/**
 * What to do about one own-wallet disposal, DERIVED from the ledger.
 *
 * `blocked` is a first-class outcome and not an error. SC-347 spent a whole
 * ticket undoing 17 transfer groups that asserted a movement nobody made, and
 * every one of them came from a rule that had to produce an answer. The
 * decision here is between two claims about the world — "that inflow is this
 * money" and "the money arrived somewhere Scani tracks and nothing imported it"
 * — and where the ledger supports neither, saying so is the correct output.
 */
export interface OwnWalletRepairPlan {
  disposal: OwnWalletDisposal;
  symbol: string;
  action: 'paired' | 'internal' | 'blocked';
  /** `paired`: the arrival to claim. */
  matchTransactionId: string | null;
  /** `paired`: the matcher-made group that must be broken before it can be
   *  claimed. `claimInflow` will not take a claimed inflow. */
  blockingGroupId: string | null;
  /** `internal`: the holding the money moved to. Never a holding to CREATE. */
  destination: TransferDestinationRef | null;
  /** `blocked`: the sentence explaining what the ledger does not support. */
  blockedReason: string | null;
}

/**
 * Turn own-wallet disposals into corrections, through `TransferReviewService`
 * and never raw SQL (SC-350, SC-365).
 *
 * **Why a use case and not a script.** SC-350's repair was 559 lines of script
 * with the derivation inline, and the derivation is the part that can be wrong
 * about money: choosing `paired` where the arrival does not exist links a leg
 * that is not there, and choosing `internal` where it does double-counts the
 * arrival. Here it is a service method with tests around it, and the script is
 * a printer.
 *
 * **The population is never a list.** `plansFor` starts from
 * `TransferReviewService.ownWalletDisposals`, so a row is repaired because it
 * violates the invariant today, not because it was measured violating it on
 * some earlier afternoon. A caller that knows which ids it expects passes them
 * as an assertion, not as input — see `scripts/repair-sc365-own-wallet-disposal.ts`.
 */
@Service()
export class RepairOwnWalletDisposalsUseCase {
  private readonly reviewService = Container.get(TransferReviewService);

  async plansFor(userId: string): Promise<OwnWalletRepairPlan[]> {
    const disposals = await this.reviewService.ownWalletDisposals(userId);
    const plans: OwnWalletRepairPlan[] = [];
    for (const disposal of disposals) plans.push(await this.planFor(disposal));
    return plans;
  }

  /**
   * The whole decision, in the order the evidence narrows it.
   *
   * The two same-holding refusals in here are the SC-347 lesson made
   * mechanical. A transfer group whose legs sit on ONE holding is a no-op that
   * `CostBasisService`'s two folds disagreed about — `walkLots` destroyed the
   * lot and re-minted it at the transfer date's market price — and 17 of
   * production's 43 same-holding groups were exactly that artifact. Answering
   * `paired` or `internal` into the row's own holding would manufacture a
   * fresh one, so this refuses instead.
   */
  private async planFor(disposal: OwnWalletDisposal): Promise<OwnWalletRepairPlan> {
    const base = {
      disposal,
      symbol: await this.symbolOf(disposal.tokenId),
      matchTransactionId: null,
      blockingGroupId: null,
      destination: null,
      blockedReason: null,
    };
    const blocked = (why: string): OwnWalletRepairPlan => ({
      ...base,
      action: 'blocked',
      blockedReason: why,
    });

    // A split answer is one row carrying several decisions, and `resolve`
    // replaces all of them. Correcting the `left_control` share alone needs
    // `resolveSplit` and a portion set nobody has chosen; refusing is honest.
    if (disposal.decision !== 'left_control') {
      return blocked(`answer is '${disposal.decision}', which this repair cannot rewrite in part`);
    }

    const [row] = await db
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.id, disposal.transactionId))
      .limit(1);
    if (!row) return blocked('row vanished between listing and planning');
    if (row.transferGroupId !== null) {
      return blocked(`already carries transfer_group_id ${row.transferGroupId}`);
    }

    const hash = txHashFromPayload(row.rawPayload, row.externalId);
    if (hash === null) {
      // Without a hash there is no way to ask whether the arrival was imported,
      // and that question is the whole paired/internal split.
      return blocked('no transaction hash — cannot tell whether the arrival is already imported');
    }

    const siblings = await db
      .select({
        id: schema.holdingTransactions.id,
        holdingId: schema.holdingTransactions.holdingId,
        quantity: schema.holdingTransactions.quantity,
        tokenId: schema.holdingTransactions.tokenId,
        transferGroupId: schema.holdingTransactions.transferGroupId,
      })
      .from(schema.holdingTransactions)
      .where(
        and(
          eq(schema.holdingTransactions.userId, disposal.userId),
          sql`${schema.holdingTransactions.rawPayload}->>'hash' = ${hash}`
        )
      );
    const arrivals = siblings.filter(
      (s) => s.id !== row.id && s.tokenId === row.tokenId && new Decimal(s.quantity).gt(0)
    );
    if (arrivals.length > 1) {
      return blocked(`${arrivals.length} candidate arrivals on ${hash} — ambiguous`);
    }

    const arrival = arrivals[0];
    if (arrival) {
      if (arrival.holdingId === row.holdingId) {
        return blocked(
          'the only arrival sits on the same holding — pairing it would assert a move'
        );
      }
      return {
        ...base,
        action: 'paired',
        matchTransactionId: arrival.id,
        blockingGroupId: arrival.transferGroupId,
      };
    }

    return this.internalPlan(disposal, row.holdingId, base, blocked);
  }

  /**
   * Where an `internal` answer sends it: the account whose registered wallet IS
   * the destination address, on the same chain.
   *
   * Matched on `accounts.metadata.walletAddress` + `chainId` rather than on the
   * account NAME, which is a truncated display string ("Ethereum -
   * 0x1414...1E49") that two different wallets sharing a prefix would both
   * satisfy.
   */
  private async internalPlan(
    disposal: OwnWalletDisposal,
    outflowHoldingId: string,
    base: Omit<OwnWalletRepairPlan, 'action'>,
    blocked: (why: string) => OwnWalletRepairPlan
  ): Promise<OwnWalletRepairPlan> {
    const [outflowAccount] = await db
      .select({ metadata: schema.accounts.metadata, id: schema.accounts.id })
      .from(schema.holdings)
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.holdings.accountId))
      .where(eq(schema.holdings.id, outflowHoldingId))
      .limit(1);
    if (!outflowAccount) return blocked('the outflow holding has no account');
    const chainId = chainIdOf(outflowAccount.metadata);

    const accounts = await db
      .select({ id: schema.accounts.id, metadata: schema.accounts.metadata })
      .from(schema.accounts)
      .where(eq(schema.accounts.userId, disposal.userId));
    const matches = accounts.filter(
      (a) =>
        walletAddressOf(a.metadata) === disposal.counterparty && chainIdOf(a.metadata) === chainId
    );
    const account = matches[0];
    if (matches.length !== 1 || !account) {
      return blocked(
        `${matches.length} accounts hold wallet ${disposal.counterparty} on chain ${chainId ?? '?'}`
      );
    }
    if (account.id === outflowAccount.id) {
      return blocked('the destination account is the account it left — nothing moved between them');
    }

    const [existing] = await db
      .select({ id: schema.holdings.id })
      .from(schema.holdings)
      .where(
        and(
          eq(schema.holdings.userId, disposal.userId),
          eq(schema.holdings.accountId, account.id),
          eq(schema.holdings.tokenId, disposal.tokenId)
        )
      )
      .limit(1);
    if (!existing) {
      // `writeInflow` would create one, opened at the amount that just moved in
      // and with `source = 'manual'` — which `HoldingsSyncHelper` skips on
      // purpose, so the balance becomes permanent and the next sync duplicates
      // the holding (SC-187). SC-350 could set the opening balance to zero
      // because a balance sync had just shown those wallets holding none of the
      // token. That is a measurement, not a rule, so it is not assumed here.
      return blocked(
        `no ${base.symbol} holding on the destination account — creating one would open a ` +
          'balance no sync can retract (SC-187); check the wallet’s real balance first'
      );
    }

    return {
      ...base,
      action: 'internal',
      destination: { accountId: account.id, holdingId: existing.id },
    };
  }

  /**
   * Write one plan. `unlink` → `reopen` → `resolve`, in that order and never
   * around them: every created deposit, coverage bound and group id stays
   * `TransferReviewService`'s business rather than this file's.
   *
   * Throws rather than returning a result. A repair applies a plan that was
   * printed and read first, so a refusal here means the world changed under it
   * — and continuing to the next row would leave a half-applied correction
   * nobody chose.
   */
  async apply(plan: OwnWalletRepairPlan): Promise<void> {
    const id = plan.disposal.transactionId;
    if (plan.action === 'blocked') {
      throw new Error(`${id}: refusing to apply a blocked plan — ${plan.blockedReason}`);
    }

    if (plan.blockingGroupId && plan.matchTransactionId) {
      const unlinked = await this.reviewService.unlinkPair(
        plan.disposal.userId,
        plan.matchTransactionId
      );
      if (!unlinked.ok) throw new Error(`${id}: unlinkPair failed — ${unlinked.reason}`);
    }

    const reopened = await this.reviewService.reopen(plan.disposal.userId, id);
    if (!reopened) throw new Error(`${id}: reopen returned false`);

    const result = await this.reviewService.resolve(plan.disposal.userId, id, plan.action, {
      answerSource: 'repair',
      ...(plan.matchTransactionId ? { matchTransactionId: plan.matchTransactionId } : {}),
      ...(plan.destination ? { destination: plan.destination } : {}),
    });
    if (!result.ok) throw new Error(`${id}: resolve('${plan.action}') failed — ${result.reason}`);
  }

  private async symbolOf(tokenId: string): Promise<string> {
    const [token] = await db
      .select({ symbol: schema.tokens.symbol })
      .from(schema.tokens)
      .where(eq(schema.tokens.id, tokenId))
      .limit(1);
    return token?.symbol ?? tokenId;
  }
}

/** `accounts.metadata.chainId`, which the wallet importer writes as a string
 *  and older rows carry as a number. Null when the account has no chain. */
function chainIdOf(metadata: unknown): string | null {
  const raw = (metadata as { chainId?: unknown } | null)?.chainId;
  if (typeof raw === 'number') return String(raw);
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  return null;
}

/** `accounts.metadata.walletAddress`, lowercased — the same normalisation
 *  `ownWalletDisposals` puts on the counterparty it is compared against. */
function walletAddressOf(metadata: unknown): string | null {
  const raw = (metadata as { walletAddress?: unknown } | null)?.walletAddress;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim().toLowerCase() : null;
}

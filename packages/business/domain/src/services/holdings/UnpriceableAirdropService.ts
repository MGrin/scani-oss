import type { DatabaseTransaction } from '@scani/db';
import { Container, Service } from 'typedi';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { TokenRepository } from '../../repositories/TokenRepository';

export interface UnpriceableAirdrop {
  holdingId: string;
  tokenSymbol: string;
  tokenName: string;
  tokenTypeCode: string;
  accountName: string;
  balance: string;
  /** When the sync first wrote the holding. */
  arrivedAt: Date;
}

/** A holding the owner asked to keep is not theirs, or does not exist. */
export class KeptHoldingNotFoundError extends Error {
  constructor(readonly holdingIds: string[]) {
    super(`Holdings not found: ${holdingIds.join(', ')}`);
    this.name = 'KeptHoldingNotFoundError';
  }
}

/**
 * Tokens that arrived in a synced wallet and that nothing can price (SC-1469).
 *
 * Selection is behavioural, never the scam score: the token has never had a
 * price row AND is inside an unpriceable cooldown — the predicate the holdings
 * list badges by and the net-worth chart sets aside by (SC-146). The 0.3 scam
 * bucket also holds USDT, so a score threshold would offer to hide Tether.
 *
 * `source === 'blockchain'` is what a wallet sync writes, and it is the same
 * test `DeleteHoldingUseCase` uses to hide rather than delete — so every row
 * listed here can come back through Restore. Hidden and scam-hidden holdings
 * are already out of the list, so they are not asked about again.
 *
 * Keeping one is the other answer, and it is remembered on `holdings.arrival`
 * rather than a column of its own: `user_confirmed` already means "a human was
 * shown this position", which is exactly what the sheet did. So a confirmed
 * holding is never listed, and only a row's creation writes `arrival`, so the
 * hourly sync cannot undo the answer.
 */
@Service()
export class UnpriceableAirdropService {
  private readonly holdings = Container.get(HoldingRepository);
  private readonly tokens = Container.get(TokenRepository);

  async listPending(
    userId: string,
    transaction?: DatabaseTransaction,
    at: Date = new Date()
  ): Promise<UnpriceableAirdrop[]> {
    const visible = await this.holdings.findByUserWithFullDetails(userId, undefined, transaction);
    const fromWallets = visible.filter(
      ({ holding }) =>
        holding.isActive && holding.source === 'blockchain' && holding.arrival !== 'user_confirmed'
    );
    const unpriceable = await this.tokens.findNeverPricedInCooldownTokenIds(
      [...new Set(fromWallets.map(({ token }) => token.id))],
      at,
      transaction
    );
    return fromWallets
      .filter(({ token }) => unpriceable.has(token.id))
      .map(({ holding, token, account }) => ({
        holdingId: holding.id,
        tokenSymbol: token.symbol,
        tokenName: token.name,
        tokenTypeCode: token.typeCode,
        accountName: account.name,
        balance: holding.balance,
        arrivedAt: holding.createdAt,
      }))
      .sort(
        (a, b) =>
          a.accountName.localeCompare(b.accountName) || a.tokenSymbol.localeCompare(b.tokenSymbol)
      );
  }

  /**
   * The owner was shown these and kept them. All or nothing: one id that is not
   * the owner's refuses the whole batch and writes nothing.
   */
  async keep(
    userId: string,
    holdingIds: readonly string[],
    transaction?: DatabaseTransaction
  ): Promise<string[]> {
    const requested = [...new Set(holdingIds)];
    const owned = new Set(await this.holdings.findIdsForUser(userId, undefined, transaction));
    const foreign = requested.filter((id) => !owned.has(id));
    if (foreign.length > 0) throw new KeptHoldingNotFoundError(foreign);
    await this.holdings.markUserConfirmed(userId, requested, transaction);
    return requested;
  }
}

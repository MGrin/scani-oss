import { type DatabaseTransaction, getDb } from '@scani/db';
import type { Holding } from '@scani/db/schema';
import { Container, Service } from 'typedi';
import { AccountRepository } from '../../repositories/AccountRepository';
import { BalanceSyncOwnershipService } from '../accounts/BalanceSyncOwnershipService';
import { BaseService } from '../BaseService';

/**
 * Whether a holding's balance can be re-fetched from where it came from, and
 * when it cannot, which part is missing: no feed states it (`not-a-feed`), or
 * no live wallet or credential is left to ask (`no-live-sync`). A feed holding
 * is the sync's to write whatever its source (A5 D-4), so a person's row a feed
 * took over is answered like any other.
 */
export type BalanceRefreshability = 'refreshable' | 'not-a-feed' | 'no-live-sync';

type RefreshCandidate = Pick<Holding, 'id' | 'kind' | 'accountId'>;

/**
 * The one answer behind the holdings list's `refreshable` and the
 * `refreshBalance` refusal (R95, R97). Its last part is
 * `BalanceSyncOwnershipService`'s read of the live wallet and credential rows,
 * never `feed_inputs.status`, which no reader may trust yet (R94).
 */
@Service()
export class BalanceRefreshabilityService extends BaseService {
  private readonly accountRepository = Container.get(AccountRepository);
  private readonly syncOwnership = Container.get(BalanceSyncOwnershipService);

  constructor() {
    super('BalanceRefreshabilityService');
  }

  async forHolding(
    userId: string,
    holding: RefreshCandidate,
    tx?: DatabaseTransaction
  ): Promise<BalanceRefreshability> {
    return answerFor(holding, await this.accountsWithLiveSync(userId, [holding], tx));
  }

  async forHoldings(
    userId: string,
    holdings: readonly RefreshCandidate[],
    tx?: DatabaseTransaction
  ): Promise<Map<string, BalanceRefreshability>> {
    const live = await this.accountsWithLiveSync(userId, holdings, tx);
    return new Map(holdings.map((holding) => [holding.id, answerFor(holding, live)]));
  }

  /**
   * The accounts holding a feed the sync can write are asked about together,
   * in the same few reads however many there are (R96); an account holding
   * none is not asked about.
   */
  private async accountsWithLiveSync(
    userId: string,
    holdings: readonly RefreshCandidate[],
    tx: DatabaseTransaction | undefined
  ): Promise<Set<string>> {
    const accountIds = [
      ...new Set(
        holdings.filter((holding) => holding.kind === 'feed').map((holding) => holding.accountId)
      ),
    ];
    if (accountIds.length === 0) return new Set();
    const accounts = await this.accountRepository.findByIds(accountIds, tx);
    const sources = await this.syncOwnership.resolveSyncSources(userId, accounts, tx ?? getDb());
    return new Set(
      [...sources].flatMap(([accountId, source]) => (source === null ? [] : [accountId]))
    );
  }
}

function answerFor(
  holding: RefreshCandidate,
  accountsWithLiveSync: ReadonlySet<string>
): BalanceRefreshability {
  if (holding.kind !== 'feed') return 'not-a-feed';
  return accountsWithLiveSync.has(holding.accountId) ? 'refreshable' : 'no-live-sync';
}

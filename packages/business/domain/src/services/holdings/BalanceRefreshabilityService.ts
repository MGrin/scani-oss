import { type DatabaseTransaction, getDb } from '@scani/db';
import type { Holding } from '@scani/db/schema';
import { Container, Service } from 'typedi';
import { AccountRepository } from '../../repositories/AccountRepository';
import { BalanceSyncOwnershipService } from '../accounts/BalanceSyncOwnershipService';
import { BaseService } from '../BaseService';
import { MANUAL_HOLDING_SOURCE } from './balance-sync-sources';

/**
 * Whether a holding's balance can be re-fetched from where it came from, and
 * when it cannot, which part is missing: no feed states it (`not-a-feed`); one
 * does, on a row the balance sync never writes (`sync-cannot-write`); or the
 * sync could write it and no live wallet or credential is left to ask
 * (`no-live-sync`).
 */
export type BalanceRefreshability =
  | 'refreshable'
  | 'not-a-feed'
  | 'sync-cannot-write'
  | 'no-live-sync';

type RefreshCandidate = Pick<Holding, 'id' | 'kind' | 'source' | 'accountId'>;

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
        holdings
          .filter((holding) => settledByItsRow(holding) === null)
          .map((holding) => holding.accountId)
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

/** What the holding's own row settles, before its account is asked about; null when it settles nothing. */
function settledByItsRow(holding: RefreshCandidate): 'not-a-feed' | 'sync-cannot-write' | null {
  if (holding.kind !== 'feed') return 'not-a-feed';
  // The balance sync's matcher never returns a row at this source
  // (`HoldingResolver.findFeedHolding`, `exceptSource`): a refresh would open
  // a row beside this one and leave it as it stands. D-4 lifts that at A5, and
  // this clause and its answer go with it.
  if (holding.source === MANUAL_HOLDING_SOURCE) return 'sync-cannot-write';
  return null;
}

function answerFor(
  holding: RefreshCandidate,
  accountsWithLiveSync: ReadonlySet<string>
): BalanceRefreshability {
  return (
    settledByItsRow(holding) ??
    (accountsWithLiveSync.has(holding.accountId) ? 'refreshable' : 'no-live-sync')
  );
}

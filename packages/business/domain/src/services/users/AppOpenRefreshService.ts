import { Container, Service } from 'typedi';
import { AccountRepository } from '../../repositories/AccountRepository';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { BalanceRefreshabilityService } from '../holdings/BalanceRefreshabilityService';

const RECENTLY_SYNCED_MS = 10 * 60_000;

/**
 * The accounts to re-fetch when a user opens the app (SC-1602): every account
 * behind a refreshable holding, less those synced in the last ten minutes, so
 * a reload or a second tab does not ask the provider again.
 */
@Service()
export class AppOpenRefreshService {
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly accountRepository = Container.get(AccountRepository);
  private readonly refreshability = Container.get(BalanceRefreshabilityService);

  async accountsToRefresh(userId: string, now: Date = new Date()): Promise<string[]> {
    const holdings = await this.holdingRepository.findByUser(userId);
    const answers = await this.refreshability.forHoldings(userId, holdings);
    const refreshable = [
      ...new Set(
        holdings.filter((h) => answers.get(h.id) === 'refreshable').map((h) => h.accountId)
      ),
    ];
    if (refreshable.length === 0) return [];
    const accounts = await this.accountRepository.findByIds(refreshable);
    return accounts
      .filter((account) => {
        const lastSync = (account.metadata as { lastSync?: string } | null)?.lastSync;
        return !lastSync || now.getTime() - new Date(lastSync).getTime() >= RECENTLY_SYNCED_MS;
      })
      .map((account) => account.id);
  }
}

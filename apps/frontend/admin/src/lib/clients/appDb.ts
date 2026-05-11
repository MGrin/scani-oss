/**
 * Facade over the per-domain DB modules under `./db/*`. Existing callers
 * — `Overview` and the legacy combined view — still call
 * `getAppDbStats()` and get a single bag of counts. New pages should
 * import directly from `./db/userStats`, `./db/holdingStats`, etc. so
 * each page only pays for the SQL it actually renders.
 */
import { cached } from '../cache';
import { type Result, tryCatch } from '../result';
import { getHoldingStats } from './db/holdingStats';
import { getIntegrationStats } from './db/integrationStats';
import { getUserStats } from './db/userStats';

export interface AppDbStats {
  users: number;
  activeSessions: number;
  vaults: number;
  accounts: number;
  holdings: number;
  tokens: number;
  tokenPrices: number;
  institutions: number;
  userWallets: number;
  userIntegrationCredentials: number;
  tokenPricesFreshestAt: string | null;
  integrationsByInstitution: Array<{ institution: string; count: number }>;
  topInstitutions: Array<{ institution: string; accounts: number }>;
  dbSizeBytes: number;
  dbSizePretty: string;
}

export async function getAppDbStats(): Promise<Result<AppDbStats>> {
  return tryCatch(() =>
    cached('app-db:stats', 60, async () => {
      const [users, holdings, integrations] = await Promise.all([
        getUserStats(),
        getHoldingStats(),
        getIntegrationStats(),
      ]);
      if (!users.ok) throw new Error(users.error);
      if (!holdings.ok) throw new Error(holdings.error);
      if (!integrations.ok) throw new Error(integrations.error);

      return {
        users: users.data.users,
        activeSessions: users.data.activeSessions,
        vaults: users.data.vaults,
        accounts: users.data.accounts,
        holdings: holdings.data.holdings,
        tokens: holdings.data.tokens,
        tokenPrices: holdings.data.tokenPrices,
        institutions: integrations.data.institutions,
        userWallets: holdings.data.userWallets,
        userIntegrationCredentials: integrations.data.userIntegrationCredentials,
        tokenPricesFreshestAt: holdings.data.tokenPricesFreshestAt,
        integrationsByInstitution: integrations.data.integrationsByInstitution,
        topInstitutions: integrations.data.topInstitutions,
        dbSizeBytes: holdings.data.dbSizeBytes,
        dbSizePretty: holdings.data.dbSizePretty,
      };
    })
  );
}

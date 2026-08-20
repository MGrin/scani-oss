import type { DatabaseTransaction } from '@scani/db';
import type { Account } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, eq } from 'drizzle-orm';
import { Service } from 'typedi';
import { BaseService } from '../BaseService';
import {
  type BalanceSyncSource,
  EXCHANGE_BALANCE_SYNC_SOURCE,
  WALLET_BALANCE_SYNC_SOURCE,
} from '../holdings/balance-sync-sources';

export type SyncOwnableAccount = Pick<
  Account,
  'id' | 'userId' | 'institutionId' | 'metadata' | 'isActive'
>;

/**
 * "Will an hourly balance sync write to this account?" — and if so, under
 * which `holdings.source` (SC-356).
 *
 * Anything creating a holding outside the sync has to know this. A row the
 * sync owns is one it keeps correct; a row at `source = 'manual'` is one it
 * is forbidden to touch (`HoldingsSyncHelper`), which is right for a number
 * a person curated and wrong for a number the system inferred — on a synced
 * account the latter can never be corrected and gets DUPLICATED the next
 * time the sync sees the token.
 *
 * The two answers below mirror each sync's own account selection exactly,
 * because an over-eager "yes" here strands a holding at a balance nothing
 * updates, and a "no" reproduces the bug:
 *
 * - **Wallet** — `SyncWalletBalancesUseCase` matches an account to a wallet
 *   through `accounts.metadata.userWalletId`, over the user's ACTIVE wallets
 *   only, and deliberately refuses to resurrect an account that no longer
 *   carries the pointer.
 * - **Exchange** — `SyncExchangeBalancesUseCase` takes every ACTIVE account
 *   at an institution the user holds ACTIVE credentials for. No per-account
 *   link exists; the credential is per (user, institution).
 */
@Service()
export class BalanceSyncOwnershipService extends BaseService {
  constructor() {
    super('BalanceSyncOwnershipService');
  }

  async resolveSyncSource(
    account: SyncOwnableAccount,
    tx: DatabaseTransaction
  ): Promise<BalanceSyncSource | null> {
    const metadata = account.metadata as Record<string, unknown> | null | undefined;
    const userWalletId = metadata?.userWalletId;
    if (typeof userWalletId === 'string' && userWalletId.length > 0) {
      const [wallet] = await tx
        .select({ id: schema.userWallets.id })
        .from(schema.userWallets)
        .where(
          and(
            eq(schema.userWallets.id, userWalletId),
            eq(schema.userWallets.userId, account.userId),
            eq(schema.userWallets.isActive, true)
          )
        )
        .limit(1);
      if (wallet) return WALLET_BALANCE_SYNC_SOURCE;
    }

    if (!account.isActive) return null;

    const [credential] = await tx
      .select({ id: schema.userIntegrationCredentials.id })
      .from(schema.userIntegrationCredentials)
      .where(
        and(
          eq(schema.userIntegrationCredentials.userId, account.userId),
          eq(schema.userIntegrationCredentials.institutionId, account.institutionId),
          eq(schema.userIntegrationCredentials.isActive, true)
        )
      )
      .limit(1);
    if (credential) return EXCHANGE_BALANCE_SYNC_SOURCE;

    return null;
  }
}

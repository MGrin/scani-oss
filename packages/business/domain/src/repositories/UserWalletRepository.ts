import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { NewUserWallet, UserWallet } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { Service } from 'typedi';

/**
 * A wallet the hourly `wallet-balances` job has stopped servicing (SC-470).
 *
 * The unit is the ACCOUNT — one per (wallet address, chain) — not the wallet
 * row. `SyncWalletBalancesUseCase` fans out over `user_wallets.institutionIds`
 * and handles each chain independently: a chain with no registered balance
 * fetcher is `continue`d past forever, and a provider that throws is caught
 * per chain. Both leave that one chain permanently silent next to siblings
 * that are syncing fine, which is exactly the fault a wallet-level `bool_and`
 * would hide.
 */
/**
 * The same 6…4 shape `ImportWalletAddressUseCase.computeWalletLabel` gives a
 * wallet the user never named. Used only when `user_wallets.label` is empty —
 * a bare 42-character address in a subject line is unreadable, and the subject
 * is where a single stale wallet's name ends up.
 */
function shortAddress(address: string): string {
  if (address.length <= 20) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export type StaleWalletTarget = {
  /** The wallet account. Doubles as the alert dedupe key. */
  accountId: string;
  userId: string;
  userWalletId: string;
  /** The user's own name for the wallet; falls back to the raw address. */
  walletLabel: string;
  walletAddress: string;
  /** The chain this account covers — "Ethereum", "Bitcoin", … */
  institutionName: string;
  /** Null when the account has never completed a single sync. */
  lastSync: Date | null;
};

@Service()
export class UserWalletRepository extends BaseRepository<UserWallet, NewUserWallet> {
  protected readonly table = schema.userWallets;
  protected readonly tableName = 'user_wallets';

  /**
   * Find all wallets for a user
   */
  async findByUser(userId: string, transaction?: DatabaseTransaction): Promise<UserWallet[]> {
    try {
      const database = this.getDb(transaction);
      return await database
        .select()
        .from(schema.userWallets)
        .where(and(eq(schema.userWallets.userId, userId), eq(schema.userWallets.isActive, true)))
        .orderBy(schema.userWallets.createdAt);
    } catch (error) {
      this.logger.error({ userId, error }, 'Failed to find wallets by user');
      throw error;
    }
  }

  /**
   * Wallet accounts whose last successful sync predates `cutoff` (SC-470).
   *
   * **Why this is not `InstitutionRepository.findStaleSyncTargets` with the
   * `crypto_wallet` exclusion removed.** That query is keyed on
   * `user_integration_credentials`, and for a wallet that row is not a
   * credential at all: `ImportWalletAddressUseCase.storePublicRpcMarkers`
   * writes a `{ type: 'public_rpc' }` marker per chain, best-effort — the
   * insert is wrapped in a try/catch that logs at debug and swallows — so a
   * wallet may have no row to be found by. Three further mismatches follow
   * from the same keying:
   *
   * 1. Its `orphaned-credential` branch is meaningless here. The wallet sync
   *    is address-based and never reads a credential, so "credential with no
   *    account" describes nothing a user can act on; the markers are even
   *    parked at `import_status = 'enqueued'` so the orphan reconciler leaves
   *    them alone.
   * 2. The marker is per (user, chain) while accounts are per (wallet, chain).
   *    Two addresses on Ethereum share one marker, and that query's
   *    `bool_and` over the accounts joined to it goes false the moment either
   *    is fresh — one live wallet silences its dead neighbour.
   * 3. `last_used_at`, the other liveness signal on that table, is frozen at
   *    creation for every wallet, because only `getDecryptedCredentials`
   *    stamps it and the wallet path never calls it (SC-248).
   *
   * The account is the row that carries the signal — `SyncWalletBalancesUseCase`
   * stamps `metadata.lastSync` on it after every successful chain — so the
   * probe is keyed there.
   *
   * Two deliberate differences from the credentialed query:
   *
   * - A never-synced account is measured from `created_at`, not `'epoch'`. An
   *   account imported ten minutes ago has not been silent for a day, and
   *   telling its owner their brand-new wallet is broken is the worst first
   *   email this product could send. `IntegrationImportService` does stamp
   *   `lastSync` at import so the null case is rare, but the cron's
   *   auto-create-for-a-new-chain path can produce one.
   * - Hidden accounts are excluded. `AccountRepository.findByUser` hides them,
   *   so the /integrations page the letter links to does not list them — an
   *   alert whose destination cannot show the thing it names is a dead end.
   */
  async findStaleWalletTargets(
    cutoff: Date,
    transaction?: DatabaseTransaction
  ): Promise<StaleWalletTarget[]> {
    const database = this.getDb(transaction);
    // Joined on the metadata text rather than `::uuid` on purpose: a single
    // account whose `userWalletId` is not uuid-shaped would abort the whole
    // statement, and this runs unattended once a day.
    const rows = (await database.execute(sql`
      select a.id as account_id, a.user_id, uw.id as user_wallet_id,
        uw.label as wallet_label, uw.wallet_address, i.name as institution_name,
        (a.metadata->>'lastSync')::timestamptz as last_sync
      from accounts a
      join user_wallets uw
        on uw.id::text = a.metadata->>'userWalletId'
       -- The letter is addressed to a.user_id and NAMES uw.label. Without
       -- this, one mis-set userWalletId puts another account's wallet label
       -- in someone's inbox — a tenant boundary an alert may not cross on
       -- the strength of a metadata field.
       and uw.user_id = a.user_id
      join institutions i on i.id = a.institution_id
      where a.is_active
        and not a.is_hidden
        and uw.is_active
        and coalesce((a.metadata->>'lastSync')::timestamptz, a.created_at)
              < ${cutoff.toISOString()}::timestamptz
      order by a.id
    `)) as unknown as Array<{
      account_id: string;
      user_id: string;
      user_wallet_id: string;
      wallet_label: string | null;
      wallet_address: string;
      institution_name: string;
      last_sync: string | Date | null;
    }>;
    return rows.map((r) => ({
      accountId: r.account_id,
      userId: r.user_id,
      userWalletId: r.user_wallet_id,
      walletLabel: r.wallet_label?.trim() || shortAddress(r.wallet_address),
      walletAddress: r.wallet_address,
      institutionName: r.institution_name,
      lastSync: r.last_sync ? new Date(r.last_sync) : null,
    }));
  }

  /**
   * Find wallet by address for a specific user
   */
  async findByUserAndAddress(
    userId: string,
    walletAddress: string,
    transaction?: DatabaseTransaction
  ): Promise<UserWallet | undefined> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .select()
        .from(schema.userWallets)
        .where(
          and(
            eq(schema.userWallets.userId, userId),
            eq(schema.userWallets.walletAddress, walletAddress),
            eq(schema.userWallets.isActive, true)
          )
        )
        .limit(1);

      return results[0];
    } catch (error) {
      this.logger.error({ userId, walletAddress, error }, 'Failed to find wallet by address');
      throw error;
    }
  }

  /**
   * Find all wallets by address (across all users)
   */
  async findByAddress(
    walletAddress: string,
    transaction?: DatabaseTransaction
  ): Promise<UserWallet[]> {
    try {
      const database = this.getDb(transaction);
      return await database
        .select()
        .from(schema.userWallets)
        .where(
          and(
            eq(schema.userWallets.walletAddress, walletAddress),
            eq(schema.userWallets.isActive, true)
          )
        )
        .orderBy(schema.userWallets.createdAt);
    } catch (error) {
      this.logger.error({ walletAddress, error }, 'Failed to find wallets by address');
      throw error;
    }
  }

  /**
   * Find wallets by institution ID (networks)
   */
  async findByInstitution(
    institutionId: string,
    transaction?: DatabaseTransaction
  ): Promise<UserWallet[]> {
    try {
      const database = this.getDb(transaction);
      // Use PostgreSQL JSONB @> operator for efficient filtering
      const results = await database
        .select()
        .from(schema.userWallets)
        .where(
          and(
            eq(schema.userWallets.isActive, true),
            sql`${schema.userWallets.institutionIds} @> ${JSON.stringify([institutionId])}::jsonb`
          )
        );

      return results;
    } catch (error) {
      this.logger.error({ institutionId, error }, 'Failed to find wallets by institution');
      throw error;
    }
  }
}

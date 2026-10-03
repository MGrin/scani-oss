import type { DatabaseTransaction } from '@scani/db';
import type { Account } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
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

  /**
   * Null when no sync owns the account. An account that is not `userId`'s is
   * refused: null is the answer callers write on (a manual holding opened at
   * the amount, an anchor moved), so a caller that read the account under
   * another user must not be handed it.
   */
  async resolveSyncSource(
    userId: string,
    account: SyncOwnableAccount,
    tx: DatabaseTransaction
  ): Promise<BalanceSyncSource | null> {
    if (account.userId !== userId) {
      throw new Error(`account ${account.id} is not user ${userId}'s`);
    }
    return (await this.resolveSyncSources(userId, [account], tx)).get(account.id) ?? null;
  }

  /**
   * The answer for each of `userId`'s accounts among `accounts`, in two reads
   * at most however many there are: the wallets they point at, then the
   * credentials at the institutions of the active ones no live wallet claimed.
   * An account that is not theirs is not answered: it has no entry. The rule
   * is stated here and nowhere else; `resolveSyncSource` is this, asked about
   * one account, and refuses the account this leaves out.
   */
  async resolveSyncSources(
    userId: string,
    accounts: readonly SyncOwnableAccount[],
    tx: DatabaseTransaction
  ): Promise<Map<string, BalanceSyncSource | null>> {
    const own = accounts.filter((account) => account.userId === userId);
    const walletOwned = await this.pointingAtLiveWallet(userId, own, tx);
    const credentialed = await this.atLiveCredential(
      userId,
      own.filter((account) => account.isActive && !walletOwned.has(account.id)),
      tx
    );
    const sourceOf = (account: SyncOwnableAccount): BalanceSyncSource | null => {
      if (walletOwned.has(account.id)) return WALLET_BALANCE_SYNC_SOURCE;
      if (credentialed.has(account.id)) return EXCHANGE_BALANCE_SYNC_SOURCE;
      return null;
    };
    return new Map(own.map((account) => [account.id, sourceOf(account)]));
  }

  private async pointingAtLiveWallet(
    userId: string,
    accounts: readonly SyncOwnableAccount[],
    tx: DatabaseTransaction
  ): Promise<Set<string>> {
    const pointing = accounts.flatMap((account) => {
      const pointer = walletPointerOf(account);
      if (pointer === null) return [];
      const walletId = uuidDigits(pointer);
      if (walletId === null) {
        // Postgres would refuse the whole read over this one pointer.
        this.logger.warn(
          { accountId: account.id },
          'accounts.metadata.userWalletId is not a uuid; the account is read as pointing at no wallet'
        );
        return [];
      }
      return [{ account, walletId }];
    });
    if (pointing.length === 0) return new Set();
    const wallets = await tx
      .select({ id: schema.userWallets.id })
      .from(schema.userWallets)
      .where(
        and(
          eq(schema.userWallets.userId, userId),
          inArray(schema.userWallets.id, distinct(pointing.map(({ walletId }) => walletId))),
          eq(schema.userWallets.isActive, true)
        )
      );
    const live = new Set(wallets.map((wallet) => uuidDigits(wallet.id)));
    return new Set(
      pointing.filter(({ walletId }) => live.has(walletId)).map(({ account }) => account.id)
    );
  }

  private async atLiveCredential(
    userId: string,
    accounts: readonly SyncOwnableAccount[],
    tx: DatabaseTransaction
  ): Promise<Set<string>> {
    if (accounts.length === 0) return new Set();
    const credentials = await tx
      .select({ institutionId: schema.userIntegrationCredentials.institutionId })
      .from(schema.userIntegrationCredentials)
      .where(
        and(
          eq(schema.userIntegrationCredentials.userId, userId),
          inArray(
            schema.userIntegrationCredentials.institutionId,
            distinct(accounts.map((account) => account.institutionId))
          ),
          eq(schema.userIntegrationCredentials.isActive, true)
        )
      );
    const live = new Set(credentials.map((credential) => credential.institutionId));
    return new Set(
      accounts.filter((account) => live.has(account.institutionId)).map((account) => account.id)
    );
  }
}

function walletPointerOf(account: SyncOwnableAccount): string | null {
  const metadata = account.metadata as Record<string, unknown> | null | undefined;
  const userWalletId = metadata?.userWalletId;
  return typeof userWalletId === 'string' && userWalletId.length > 0 ? userWalletId : null;
}

const UUID_GROUPS = '(?:[0-9a-f]{4}-?){7}[0-9a-f]{4}';
const UUID_TEXT = new RegExp(`^(?:${UUID_GROUPS}|\\{${UUID_GROUPS}\\})$`, 'i');

/**
 * The 32 digits of a uuid, or null for text Postgres does not read as one. It
 * reads either case, a hyphen after any group of four digits, and braces
 * around the whole, and the pointer is free text in `metadata`. Comparing
 * digits is the comparison the wallet read made on its own column, so a
 * pointer that read matched is not dropped here.
 */
function uuidDigits(text: string): string | null {
  return UUID_TEXT.test(text) ? text.toLowerCase().replace(/[^0-9a-f]/g, '') : null;
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

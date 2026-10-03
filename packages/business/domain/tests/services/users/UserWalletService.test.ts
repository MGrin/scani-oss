/**
 * What creating, deactivating, re-activating and removing a wallet does, as a
 * person sees it: the stored row, the wallets list, and whether the hourly
 * wallet sync owns the accounts that point at it. Pinned before A2 Task 20 made
 * feed inputs follow the wallet, which moves none of it (D-1).
 *
 * The service writes through its own connection, so the fixtures are committed.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { BalanceSyncOwnershipService } from '../../../src/services/accounts/BalanceSyncOwnershipService';
import { WALLET_BALANCE_SYNC_SOURCE } from '../../../src/services/holdings/balance-sync-sources';
import { UserWalletService } from '../../../src/services/users/UserWalletService';
import { committedRows } from '../../../test/helpers/committed-rows';
import { commitChainOwner } from '../../../test/helpers/committed-seeds';
import { makeChainAccount } from '../../../test/helpers/factories-extra';

const rows = committedRows();
afterEach(rows.drop);

const wallets = () => Container.get(UserWalletService);
const address = () => `0x${randomUUID().replace(/-/g, '')}`;

const storedWallets = (userId: string) =>
  getDb().select().from(schema.userWallets).where(eq(schema.userWallets.userId, userId));

const syncSourceOf = (account: typeof schema.accounts.$inferSelect) =>
  getDb().transaction((tx) =>
    Container.get(BalanceSyncOwnershipService).resolveSyncSource(account.userId, account, tx)
  );

describe('UserWalletService — the wallet lifecycle, as today', () => {
  test('creating stores an active wallet, and a second one at the same address is refused', async () => {
    const seeded = await commitChainOwner(rows);
    const at = address();

    const created = await wallets().createWallet({
      userId: seeded.userId,
      walletAddress: at,
      institutionIds: [seeded.institutionId],
      isActive: true,
    });

    expect(created.isActive).toBe(true);
    expect((await wallets().getUserWallets(seeded.userId)).map((w) => w.id)).toEqual([created.id]);
    await expect(
      wallets().createWallet({ userId: seeded.userId, walletAddress: at, isActive: true })
    ).rejects.toThrow('Wallet with this address already exists for this user');
    expect(await storedWallets(seeded.userId)).toHaveLength(1);
  });

  test("deleting deactivates and updating re-activates; the wallet sync owns the wallet's account only while it is active", async () => {
    const seeded = await commitChainOwner(rows);
    const wallet = await wallets().createWallet({
      userId: seeded.userId,
      walletAddress: address(),
      institutionIds: [seeded.institutionId],
      isActive: true,
    });
    const account = await getDb().transaction((tx) => makeChainAccount(tx, seeded, wallet.id));
    expect(await syncSourceOf(account)).toBe(WALLET_BALANCE_SYNC_SOURCE);

    await wallets().deleteWallet(wallet.id);
    expect((await storedWallets(seeded.userId)).map((w) => w.isActive)).toEqual([false]);
    expect(await wallets().getUserWallets(seeded.userId)).toEqual([]);
    expect(await syncSourceOf(account)).toBeNull();

    const revived = await wallets().updateWallet(wallet.id, { isActive: true });
    expect(revived.isActive).toBe(true);
    expect(await syncSourceOf(account)).toBe(WALLET_BALANCE_SYNC_SOURCE);
  });

  test("hard-deleting removes the wallet; another user's wallet is left alone", async () => {
    const seeded = await commitChainOwner(rows);
    const stranger = await commitChainOwner(rows);
    const own = await wallets().createWallet({
      userId: seeded.userId,
      walletAddress: address(),
      isActive: true,
    });
    const theirs = await wallets().createWallet({
      userId: stranger.userId,
      walletAddress: address(),
      isActive: true,
    });

    await wallets().hardDeleteWallet(theirs.id, seeded.userId);
    await wallets().hardDeleteWallet(own.id, seeded.userId);

    expect(await storedWallets(seeded.userId)).toEqual([]);
    expect((await storedWallets(stranger.userId)).map((w) => w.id)).toEqual([theirs.id]);
  });
});

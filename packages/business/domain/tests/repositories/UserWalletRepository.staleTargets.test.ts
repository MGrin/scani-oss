import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { Container } from 'typedi';
import { UserWalletRepository } from '../../src/repositories/UserWalletRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeInstitutionType, makeUser } from '../../test/helpers/factories';
import { makeAccount } from '../../test/helpers/factories-extra';

// The probe SC-459's alert could not run (SC-470). Every case here is a shape
// `InstitutionRepository.findStaleSyncTargets` gets wrong for a wallet, not a
// restatement of what it already covers.

const repo = () => Container.get(UserWalletRepository);

const CUTOFF = new Date('2026-08-20T09:00:00.000Z');
const FRESH = new Date('2026-08-21T08:00:00.000Z').toISOString();
const DEAD = new Date('2026-06-01T00:00:00.000Z').toISOString();

async function makeWallet(
  tx: DatabaseTransaction,
  overrides: Partial<typeof schema.userWallets.$inferInsert> & { userId: string }
): Promise<typeof schema.userWallets.$inferSelect> {
  const [row] = await tx
    .insert(schema.userWallets)
    .values({
      walletAddress: `0x${Math.random().toString(16).slice(2).padEnd(40, '0')}`,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('user_wallets insert failed');
  return row;
}

async function chain(tx: DatabaseTransaction, name: string) {
  const type = await makeInstitutionType(tx, { code: 'crypto_wallet' });
  return makeInstitution(tx, { name, typeId: type.id });
}

describe('UserWalletRepository.findStaleWalletTargets (SC-470)', () => {
  test('flags a wallet account whose lastSync predates the cutoff', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const eth = await chain(tx, 'Ethereum');
      const wallet = await makeWallet(tx, { userId: user.id, label: 'Ledger' });
      const account = await makeAccount(tx, {
        userId: user.id,
        institutionId: eth.id,
        metadata: { userWalletId: wallet.id, lastSync: DEAD },
      });

      const targets = await repo().findStaleWalletTargets(CUTOFF, tx);
      const hit = targets.find((t) => t.accountId === account.id);
      expect(hit?.userId).toBe(user.id);
      expect(hit?.walletLabel).toBe('Ledger');
      expect(hit?.institutionName).toBe('Ethereum');
      expect(hit?.lastSync?.toISOString()).toBe(DEAD);
    });
  });

  test('does NOT flag a wallet account synced within the window', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const eth = await chain(tx, 'Ethereum');
      const wallet = await makeWallet(tx, { userId: user.id });
      const account = await makeAccount(tx, {
        userId: user.id,
        institutionId: eth.id,
        metadata: { userWalletId: wallet.id, lastSync: FRESH },
      });

      const targets = await repo().findStaleWalletTargets(CUTOFF, tx);
      expect(targets.find((t) => t.accountId === account.id)).toBeUndefined();
    });
  });

  test('a live chain does NOT silence a dead one on the same address', async () => {
    // The exact fault the credentialed query hides. Its `bool_and` runs over
    // every account joined to one per-(user, chain) marker row, so any fresh
    // sibling clears the whole group. `SyncWalletBalancesUseCase` handles
    // chains independently — a chain with no registered balance fetcher is
    // `continue`d past forever — so this state is permanent, not transient.
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const eth = await chain(tx, 'Ethereum');
      const polygon = await chain(tx, 'Polygon');
      const wallet = await makeWallet(tx, { userId: user.id, label: 'Ledger' });
      const alive = await makeAccount(tx, {
        userId: user.id,
        institutionId: eth.id,
        metadata: { userWalletId: wallet.id, lastSync: FRESH },
      });
      const dead = await makeAccount(tx, {
        userId: user.id,
        institutionId: polygon.id,
        metadata: { userWalletId: wallet.id, lastSync: DEAD },
      });

      const targets = await repo().findStaleWalletTargets(CUTOFF, tx);
      expect(targets.find((t) => t.accountId === dead.id)?.institutionName).toBe('Polygon');
      expect(targets.find((t) => t.accountId === alive.id)).toBeUndefined();
    });
  });

  test('a never-synced account is measured from created_at, not from the epoch', async () => {
    // A wallet imported minutes ago has not been silent for a day. Coalescing
    // a missing lastSync to 'epoch' — what the credentialed query does, safely,
    // because its import always stamps one — would mail its owner on day two
    // to say their brand-new wallet is broken.
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const eth = await chain(tx, 'Ethereum');
      const wallet = await makeWallet(tx, { userId: user.id });
      const fresh = await makeAccount(tx, {
        userId: user.id,
        institutionId: eth.id,
        metadata: { userWalletId: wallet.id },
      });
      const old = await makeAccount(tx, {
        userId: user.id,
        institutionId: eth.id,
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
        metadata: { userWalletId: wallet.id },
      });

      const targets = await repo().findStaleWalletTargets(CUTOFF, tx);
      expect(targets.find((t) => t.accountId === fresh.id)).toBeUndefined();
      const hit = targets.find((t) => t.accountId === old.id);
      expect(hit).toBeDefined();
      // Null is what tells the letter to say "nothing has ever come through".
      expect(hit?.lastSync).toBeNull();
    });
  });

  test('falls back to a shortened address when the wallet carries no label', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const eth = await chain(tx, 'Ethereum');
      const wallet = await makeWallet(tx, {
        userId: user.id,
        walletAddress: '0xfeed000000000000000000000000000000000001',
        label: null,
      });
      const account = await makeAccount(tx, {
        userId: user.id,
        institutionId: eth.id,
        metadata: { userWalletId: wallet.id, lastSync: DEAD },
      });

      const targets = await repo().findStaleWalletTargets(CUTOFF, tx);
      const hit = targets.find((t) => t.accountId === account.id);
      // A bare 42-character address is what lands in the subject line when a
      // single unlabelled wallet goes stale.
      expect(hit?.walletLabel).toBe('0xfeed...0001');
      expect(hit?.walletAddress).toBe('0xfeed000000000000000000000000000000000001');
    });
  });

  test('ignores hidden and deactivated accounts, and deactivated wallets', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const eth = await chain(tx, 'Ethereum');
      const wallet = await makeWallet(tx, { userId: user.id });
      // Hidden: /integrations does not list it, so the letter's link is a
      // dead end (AccountRepository.findByUser excludes hidden accounts).
      const hidden = await makeAccount(tx, {
        userId: user.id,
        institutionId: eth.id,
        isHidden: true,
        metadata: { userWalletId: wallet.id, lastSync: DEAD },
      });
      const inactive = await makeAccount(tx, {
        userId: user.id,
        institutionId: eth.id,
        isActive: false,
        metadata: { userWalletId: wallet.id, lastSync: DEAD },
      });
      const removedWallet = await makeWallet(tx, { userId: user.id, isActive: false });
      const onRemoved = await makeAccount(tx, {
        userId: user.id,
        institutionId: eth.id,
        metadata: { userWalletId: removedWallet.id, lastSync: DEAD },
      });

      const targets = await repo().findStaleWalletTargets(CUTOFF, tx);
      const ids = targets.map((t) => t.accountId);
      expect(ids).not.toContain(hidden.id);
      expect(ids).not.toContain(inactive.id);
      expect(ids).not.toContain(onRemoved.id);
    });
  });

  test('ignores an exchange account, which has no userWalletId to join on', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const cex = await makeInstitutionType(tx, { code: 'crypto_exchange' });
      const binance = await makeInstitution(tx, { name: 'Binance', typeId: cex.id });
      const account = await makeAccount(tx, {
        userId: user.id,
        institutionId: binance.id,
        metadata: { lastSync: DEAD },
      });

      const targets = await repo().findStaleWalletTargets(CUTOFF, tx);
      expect(targets.map((t) => t.accountId)).not.toContain(account.id);
    });
  });

  test('a non-uuid userWalletId does not abort the statement', async () => {
    // This runs unattended once a day. `uw.id::text = metadata->>'userWalletId'`
    // rather than a `::uuid` cast is what keeps one malformed row from
    // costing every other account its alert.
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const eth = await chain(tx, 'Ethereum');
      await makeAccount(tx, {
        userId: user.id,
        institutionId: eth.id,
        metadata: { userWalletId: 'not-a-uuid', lastSync: DEAD },
      });
      const wallet = await makeWallet(tx, { userId: user.id });
      const good = await makeAccount(tx, {
        userId: user.id,
        institutionId: eth.id,
        metadata: { userWalletId: wallet.id, lastSync: DEAD },
      });

      const targets = await repo().findStaleWalletTargets(CUTOFF, tx);
      expect(targets.map((t) => t.accountId)).toContain(good.id);
    });
  });

  test('never joins an account to another user’s wallet', async () => {
    // The letter is addressed to the ACCOUNT's owner and names the WALLET's
    // label. One mis-set userWalletId would otherwise put a stranger's label
    // in someone's inbox.
    await withTestDb(async (tx) => {
      const owner = await makeUser(tx);
      const stranger = await makeUser(tx);
      const eth = await chain(tx, 'Ethereum');
      const strangersWallet = await makeWallet(tx, { userId: stranger.id, label: 'Not yours' });
      const account = await makeAccount(tx, {
        userId: owner.id,
        institutionId: eth.id,
        metadata: { userWalletId: strangersWallet.id, lastSync: DEAD },
      });

      const targets = await repo().findStaleWalletTargets(CUTOFF, tx);
      expect(targets.map((t) => t.accountId)).not.toContain(account.id);
    });
  });
});

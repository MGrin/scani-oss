import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { InstitutionRepository } from '../../src/repositories/InstitutionRepository';
import { withTestDb } from '../../test/helpers/db';
import {
  makeCredential,
  makeInstitution,
  makeInstitutionType,
  makeUser,
} from '../../test/helpers/factories';
import { makeAccount } from '../../test/helpers/factories-extra';

// findByUserId is the one that drives the "Institutions" screen + the
// institution-picker in add-holding. The critical contract is that the
// account-side filters MATCH `AccountRepository.findByUser` — otherwise an
// institution with only hidden accounts shows up with accountCount=0.
// Lock that contract here (see the inline comment in findByUserId).

const repo = () => Container.get(InstitutionRepository);

describe('InstitutionRepository', () => {
  test('findByUserId returns institutions reached via the user\u2019s visible accounts', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);
      await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const rows = await repo().findByUserId(user.id, tx);
      expect(rows.map((r) => r.id)).toContain(institution.id);
    });
  });

  test('findByUserId hides institutions whose only accounts are hidden', async () => {
    // Matches the comment in the method: account-side hiding filter must
    // line up with AccountRepository.findByUser.
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);
      await makeAccount(tx, {
        userId: user.id,
        institutionId: institution.id,
        isHidden: true,
      });
      const rows = await repo().findByUserId(user.id, tx);
      expect(rows.map((r) => r.id)).not.toContain(institution.id);
    });
  });

  test('findByUserId hides institutions that are themselves inactive', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx, { isActive: false });
      await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const rows = await repo().findByUserId(user.id, tx);
      expect(rows.map((r) => r.id)).not.toContain(institution.id);
    });
  });

  test('findByUserId returns distinct institutions even with multiple accounts', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);
      // Two accounts, same institution — institution must appear exactly once.
      await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const rows = await repo().findByUserId(user.id, tx);
      const matching = rows.filter((r) => r.id === institution.id);
      expect(matching.length).toBe(1);
    });
  });

  test('findByUserId scopes by userId — cross-user isolation', async () => {
    await withTestDb(async (tx) => {
      const userA = await makeUser(tx);
      const userB = await makeUser(tx);
      const institution = await makeInstitution(tx);
      await makeAccount(tx, { userId: userA.id, institutionId: institution.id });
      const aRows = await repo().findByUserId(userA.id, tx);
      const bRows = await repo().findByUserId(userB.id, tx);
      expect(aRows.map((r) => r.id)).toContain(institution.id);
      expect(bRows.map((r) => r.id)).not.toContain(institution.id);
    });
  });
});

describe('findSyncableInstitutions', () => {
  test('includes a non-crypto_wallet institution that has credentials (IBKR/Airwallex regression)', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const broker = await makeInstitutionType(tx, { code: 'broker' });
      const ibkr = await makeInstitution(tx, { name: 'Interactive Brokers', typeId: broker.id });
      await makeCredential(tx, { userId: user.id, institutionId: ibkr.id });
      const rows = await repo().findSyncableInstitutions(tx);
      expect(rows.map((r) => r.id)).toContain(ibkr.id);
    });
  });

  test('excludes crypto_wallet institutions (balances are owned by wallet-balances)', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const wallet = await makeInstitutionType(tx, { code: 'crypto_wallet' });
      const eth = await makeInstitution(tx, { name: 'Ethereum', typeId: wallet.id });
      await makeCredential(tx, { userId: user.id, institutionId: eth.id });
      const rows = await repo().findSyncableInstitutions(tx);
      expect(rows.map((r) => r.id)).not.toContain(eth.id);
    });
  });

  test('excludes institutions with no credentials', async () => {
    await withTestDb(async (tx) => {
      const broker = await makeInstitutionType(tx, { code: 'broker' });
      const inst = await makeInstitution(tx, { name: 'Lonely Broker', typeId: broker.id });
      const rows = await repo().findSyncableInstitutions(tx);
      expect(rows.map((r) => r.id)).not.toContain(inst.id);
    });
  });

  test('returns an institution once even with multiple credentials', async () => {
    await withTestDb(async (tx) => {
      const u1 = await makeUser(tx);
      const u2 = await makeUser(tx);
      const bank = await makeInstitutionType(tx, { code: 'bank' });
      const aw = await makeInstitution(tx, { name: 'Airwallex', typeId: bank.id });
      await makeCredential(tx, { userId: u1.id, institutionId: aw.id });
      await makeCredential(tx, { userId: u2.id, institutionId: aw.id });
      const rows = await repo().findSyncableInstitutions(tx);
      expect(rows.filter((r) => r.id === aw.id).length).toBe(1);
    });
  });
});

// The transaction sync's set is the balance sync's set PLUS wallets. The
// two were one method, and reading its wallet exclusion as covering both
// froze every wallet's ledger at its import (SC-360).
describe('findTransactionSyncableInstitutions', () => {
  test('INCLUDES crypto_wallet institutions — nothing else re-reads their ledger', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const wallet = await makeInstitutionType(tx, { code: 'crypto_wallet' });
      const sol = await makeInstitution(tx, { name: 'Solana', typeId: wallet.id });
      await makeCredential(tx, { userId: user.id, institutionId: sol.id });
      const rows = await repo().findTransactionSyncableInstitutions(tx);
      expect(rows.map((r) => r.id)).toContain(sol.id);
    });
  });

  test('still includes non-wallet institutions', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const broker = await makeInstitutionType(tx, { code: 'broker' });
      const ibkr = await makeInstitution(tx, { name: 'Interactive Brokers', typeId: broker.id });
      await makeCredential(tx, { userId: user.id, institutionId: ibkr.id });
      const rows = await repo().findTransactionSyncableInstitutions(tx);
      expect(rows.map((r) => r.id)).toContain(ibkr.id);
    });
  });

  test('excludes a wallet whose credential was soft-deleted', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const wallet = await makeInstitutionType(tx, { code: 'crypto_wallet' });
      const eth = await makeInstitution(tx, { name: 'Ethereum', typeId: wallet.id });
      await makeCredential(tx, { userId: user.id, institutionId: eth.id, isActive: false });
      const rows = await repo().findTransactionSyncableInstitutions(tx);
      expect(rows.map((r) => r.id)).not.toContain(eth.id);
    });
  });
});

describe('findStaleSyncTargets', () => {
  test('flags an active credentialed account whose lastSync is older than cutoff', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const broker = await makeInstitutionType(tx, { code: 'broker' });
      const ibkr = await makeInstitution(tx, { name: 'Interactive Brokers', typeId: broker.id });
      await makeCredential(tx, { userId: user.id, institutionId: ibkr.id });
      await makeAccount(tx, {
        userId: user.id,
        institutionId: ibkr.id,
        metadata: { lastSync: new Date('2020-01-01').toISOString() },
      });
      const targets = await repo().findStaleSyncTargets(new Date('2026-01-01'), tx);
      expect(targets.find((t) => t.institutionId === ibkr.id)?.kind).toBe('stale-account');
    });
  });

  test('flags a zero-account institution whose credential import failed', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const cex = await makeInstitutionType(tx, { code: 'crypto_exchange' });
      const binance = await makeInstitution(tx, { name: 'Binance', typeId: cex.id });
      await makeCredential(tx, {
        userId: user.id,
        institutionId: binance.id,
        importStatus: 'failed',
      });
      const targets = await repo().findStaleSyncTargets(new Date('2026-01-01'), tx);
      expect(targets.find((t) => t.institutionId === binance.id)?.kind).toBe('orphaned-credential');
    });
  });

  test('flags an active credential with zero accounts even at import_status=enqueued', async () => {
    // This assertion is INVERTED from the one it replaces (SC-248). The old
    // test encoded the theory that a cleanly-imported-but-empty exchange
    // lands at 0 accounts / 'enqueued' and must stay silent. That state is
    // not reachable: IntegrationImportService creates the account row before
    // skipZeroBalances is consulted, and an import discovering no accounts
    // throws. What actually lands here is a credential whose accounts were
    ***REMOVED***
    // in production because of this guard.
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const cex = await makeInstitutionType(tx, { code: 'crypto_exchange' });
      const binance = await makeInstitution(tx, { name: 'Binance', typeId: cex.id });
      const credential = await makeCredential(tx, {
        userId: user.id,
        institutionId: binance.id,
        importStatus: 'enqueued',
      });
      const targets = await repo().findStaleSyncTargets(new Date('2026-01-01'), tx);
      const hit = targets.find((t) => t.credentialId === credential.id);
      expect(hit?.kind).toBe('orphaned-credential');
      expect(hit?.userId).toBe(user.id);
    });
  });

  test('does NOT flag a credential the user disconnected (isActive = false)', async () => {
    // The soft delete AccountService performs when the last account goes is
    // what keeps the branch above from becoming the next hourly page.
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const cex = await makeInstitutionType(tx, { code: 'crypto_exchange' });
      const binance = await makeInstitution(tx, { name: 'Binance', typeId: cex.id });
      const credential = await makeCredential(tx, {
        userId: user.id,
        institutionId: binance.id,
        isActive: false,
      });
      const targets = await repo().findStaleSyncTargets(new Date('2026-01-01'), tx);
      expect(targets.find((t) => t.credentialId === credential.id)).toBeUndefined();
    });
  });

  test('one user’s accounts do not mask another user’s orphaned credential', async () => {
    // The query used to group by institution alone, so any account on a
    // shared institution satisfied `count(a.id) > 0` for every credential on
    // it. Production has two users on one Bybit institution today.
    await withTestDb(async (tx) => {
      const healthy = await makeUser(tx);
      const orphaned = await makeUser(tx);
      const cex = await makeInstitutionType(tx, { code: 'crypto_exchange' });
      const bybit = await makeInstitution(tx, { name: 'Bybit', typeId: cex.id });

      await makeCredential(tx, { userId: healthy.id, institutionId: bybit.id });
      await makeAccount(tx, {
        userId: healthy.id,
        institutionId: bybit.id,
        metadata: { lastSync: new Date('2026-06-27').toISOString() },
      });

      const orphanCredential = await makeCredential(tx, {
        userId: orphaned.id,
        institutionId: bybit.id,
      });

      const targets = await repo().findStaleSyncTargets(new Date('2026-06-01'), tx);
      expect(targets.find((t) => t.credentialId === orphanCredential.id)?.kind).toBe(
        'orphaned-credential'
      );
      expect(targets.find((t) => t.userId === healthy.id)).toBeUndefined();
    });
  });

  test('does NOT flag a freshly-synced account', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const broker = await makeInstitutionType(tx, { code: 'broker' });
      const inst = await makeInstitution(tx, { name: 'Fresh Broker', typeId: broker.id });
      await makeCredential(tx, { userId: user.id, institutionId: inst.id });
      await makeAccount(tx, {
        userId: user.id,
        institutionId: inst.id,
        metadata: { lastSync: new Date('2026-06-27').toISOString() },
      });
      const targets = await repo().findStaleSyncTargets(new Date('2026-06-01'), tx);
      expect(targets.find((t) => t.institutionId === inst.id)).toBeUndefined();
    });
  });
});

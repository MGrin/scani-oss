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

  test('excludes crypto_wallet institutions (owned by wallet-balances)', async () => {
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
      expect(targets.find((t) => t.institutionId === binance.id)?.kind).toBe('no-account');
    });
  });

  test('does NOT flag a zero-account institution whose import succeeded but is empty', async () => {
    // Regression: an exchange that imported cleanly but holds zero (or only
    // dust) balances creates 0 accounts and sits at import_status='enqueued'
    // — the healthy terminal state. The probe used to page on this hourly
    // forever (Sentry SCANI-WORKER-G, 181 events on one empty Binance link).
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const cex = await makeInstitutionType(tx, { code: 'crypto_exchange' });
      const binance = await makeInstitution(tx, { name: 'Binance', typeId: cex.id });
      await makeCredential(tx, {
        userId: user.id,
        institutionId: binance.id,
        importStatus: 'enqueued',
      });
      const targets = await repo().findStaleSyncTargets(new Date('2026-01-01'), tx);
      expect(targets.find((t) => t.institutionId === binance.id)).toBeUndefined();
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

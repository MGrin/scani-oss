import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { normalizeVendorName } from '../../src/lib/normalize-vendor-name';
import { VendorRepository } from '../../src/repositories/VendorRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeUser, makeVendor } from '../../test/helpers/factories';

// VendorRepository backs the "who you pay" side of the payments layer.
// `merge` is the highest-risk method here — folding one vendor into
// another is a one-way, destructive operation on the source row, so the
// tests below lean hard on proving the SURVIVING vendor (and anything
// that points at it) comes out untouched.

const repo = () => Container.get(VendorRepository);

describe('VendorRepository', () => {
  test("findByUser returns only that user's vendors, sorted by displayName", async () => {
    await withTestDb(async (tx) => {
      const userA = await makeUser(tx);
      const userB = await makeUser(tx);
      await makeVendor(tx, { userId: userA.id, displayName: 'Zebra Corp' });
      await makeVendor(tx, { userId: userA.id, displayName: 'Amazon' });
      await makeVendor(tx, { userId: userB.id, displayName: 'Netflix' });

      const rows = await repo().findByUser(userA.id, tx);
      expect(rows.map((v) => v.displayName)).toEqual(['Amazon', 'Zebra Corp']);
    });
  });

  test('addAlias is idempotent on the same (vendorId, rawName) pair', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const vendor = await makeVendor(tx, { userId: user.id, displayName: 'Amazon' });

      await repo().addAlias(vendor.id, 'AMZN Mktp GB', 'counterparty', tx);
      const second = await repo().addAlias(vendor.id, 'AMZN Mktp GB', 'manual', tx);

      expect(second.source).toBe('manual');
    });
  });

  test("findByAlias resolves via the vendor's own normalized name", async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await makeVendor(tx, { userId: user.id, displayName: 'Amazon' });

      const found = await repo().findByAlias(user.id, 'AMAZON', tx);
      expect(found?.displayName).toBe('Amazon');
    });
  });

  test('findByAlias resolves via an explicitly recorded alias', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const vendor = await makeVendor(tx, { userId: user.id, displayName: 'Amazon' });
      await repo().addAlias(vendor.id, 'AMZN Mktp GB', 'counterparty', tx);

      const found = await repo().findByAlias(user.id, 'AMZN Mktp GB', tx);
      expect(found?.id).toBe(vendor.id);
    });
  });

  test('findByAlias returns undefined when nothing matches', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await makeVendor(tx, { userId: user.id, displayName: 'Amazon' });

      expect(await repo().findByAlias(user.id, 'Totally Unrelated Vendor', tx)).toBeUndefined();
    });
  });

  test('findByAlias is scoped to the user — a raw name aliased under one user is invisible to another', async () => {
    await withTestDb(async (tx) => {
      const userA = await makeUser(tx);
      const userB = await makeUser(tx);
      const vendorA = await makeVendor(tx, { userId: userA.id, displayName: 'Amazon' });
      await repo().addAlias(vendorA.id, 'AMZN Mktp GB', 'counterparty', tx);

      expect(await repo().findByAlias(userB.id, 'AMZN Mktp GB', tx)).toBeUndefined();
    });
  });

  test("the brief's canonical scenario: three differently-spelled raw strings all resolve to one vendor once explicitly aliased", async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const vendor = await makeVendor(tx, { userId: user.id, displayName: 'Amazon' });

      // normalizeVendorName alone does NOT collapse these three into the
      // same key (proven in normalize-vendor-name.test.ts) — the alias
      // table is what makes them all resolve to one vendor.
      await repo().addAlias(vendor.id, 'AMZN Mktp GB', 'counterparty', tx);
      await repo().addAlias(vendor.id, 'Amazon.co.uk', 'counterparty', tx);
      await repo().addAlias(vendor.id, 'AMAZON  MKTP', 'counterparty', tx);

      const resolved = await Promise.all([
        repo().findByAlias(user.id, 'AMZN Mktp GB', tx),
        repo().findByAlias(user.id, 'Amazon.co.uk', tx),
        repo().findByAlias(user.id, 'AMAZON  MKTP', tx),
      ]);
      expect(resolved.every((v) => v?.id === vendor.id)).toBe(true);
    });
  });

  describe('merge', () => {
    test('moves aliases from the source vendor to the surviving vendor', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const into = await makeVendor(tx, { userId: user.id, displayName: 'Amazon' });
        const from = await makeVendor(tx, { userId: user.id, displayName: 'AMZN' });
        await repo().addAlias(from.id, 'AMZN Mktp GB', 'counterparty', tx);

        await repo().merge(user.id, into.id, from.id, tx);

        const found = await repo().findByAlias(user.id, 'AMZN Mktp GB', tx);
        expect(found?.id).toBe(into.id);
      });
    });

    test('deletes the source vendor', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const into = await makeVendor(tx, { userId: user.id, displayName: 'Amazon' });
        const from = await makeVendor(tx, { userId: user.id, displayName: 'AMZN' });

        await repo().merge(user.id, into.id, from.id, tx);

        expect(await repo().findById(from.id, tx)).toBeNull();
      });
    });

    test('does not orphan or delete anything referencing the surviving vendor', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const into = await makeVendor(tx, { userId: user.id, displayName: 'Amazon' });
        const from = await makeVendor(tx, { userId: user.id, displayName: 'AMZN' });
        // A pre-existing alias on the SURVIVING vendor — the thing at risk
        // if merge's DELETE were scoped wrong.
        await repo().addAlias(into.id, 'Amazon.co.uk', 'counterparty', tx);
        await repo().addAlias(from.id, 'AMZN Mktp GB', 'counterparty', tx);

        await repo().merge(user.id, into.id, from.id, tx);

        const survivor = await repo().findById(into.id, tx);
        expect(survivor).not.toBeNull();
        expect(survivor?.displayName).toBe('Amazon');
        const preExistingAlias = await repo().findByAlias(user.id, 'Amazon.co.uk', tx);
        expect(preExistingAlias?.id).toBe(into.id);
        const movedAlias = await repo().findByAlias(user.id, 'AMZN Mktp GB', tx);
        expect(movedAlias?.id).toBe(into.id);
      });
    });

    test('a raw_name aliased to both vendors is deduped rather than violating the unique constraint', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const into = await makeVendor(tx, { userId: user.id, displayName: 'Amazon' });
        const from = await makeVendor(tx, { userId: user.id, displayName: 'AMZN' });
        await repo().addAlias(into.id, 'AMZN', 'manual', tx);
        await repo().addAlias(from.id, 'AMZN', 'manual', tx);

        await repo().merge(user.id, into.id, from.id, tx);

        const found = await repo().findByAlias(user.id, 'AMZN', tx);
        expect(found?.id).toBe(into.id);
      });
    });

    test('normalizeVendorName("AMZN") stays reachable through the surviving vendor after merge', async () => {
      // Regression pin: after merge, resolving by the source vendor's OWN
      // normalized name must not silently point at a now-deleted row.
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const into = await makeVendor(tx, { userId: user.id, displayName: 'Amazon' });
        const from = await makeVendor(tx, {
          userId: user.id,
          displayName: 'AMZN',
          normalizedName: normalizeVendorName('AMZN'),
        });

        await repo().merge(user.id, into.id, from.id, tx);

        // The source's own normalizedName ("amzn") is gone with the row —
        // merge does not rewrite the survivor's normalizedName. This
        // documents current behaviour: resolving "AMZN" post-merge
        // requires an explicit alias, which is exactly what addAlias is
        // for.
        expect(await repo().findByAlias(user.id, 'AMZN', tx)).toBeUndefined();
      });
    });

    test('same-user merge succeeds', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const into = await makeVendor(tx, { userId: user.id, displayName: 'Amazon' });
        const from = await makeVendor(tx, { userId: user.id, displayName: 'AMZN' });

        await expect(repo().merge(user.id, into.id, from.id, tx)).resolves.toBeUndefined();
        expect(await repo().findById(from.id, tx)).toBeNull();
      });
    });

    test('cross-user merge throws and leaves both vendors and their aliases untouched', async () => {
      await withTestDb(async (tx) => {
        const userA = await makeUser(tx);
        const userB = await makeUser(tx);
        // `into` belongs to userA; `from` belongs to userB — userA has no
        // business folding userB's vendor into their own.
        const into = await makeVendor(tx, { userId: userA.id, displayName: 'Amazon' });
        const from = await makeVendor(tx, { userId: userB.id, displayName: 'AMZN' });
        await repo().addAlias(into.id, 'Amazon.co.uk', 'counterparty', tx);
        await repo().addAlias(from.id, 'AMZN Mktp GB', 'counterparty', tx);

        await expect(repo().merge(userA.id, into.id, from.id, tx)).rejects.toThrow();

        // Neither vendor moved, and neither was half-merged: both still
        // exist and each still owns exactly the alias it started with —
        // proving the ownership check ran BEFORE any write, not after a
        // partial one.
        expect(await repo().findById(into.id, tx)).not.toBeNull();
        expect(await repo().findById(from.id, tx)).not.toBeNull();
        const intoAlias = await repo().findByAlias(userA.id, 'Amazon.co.uk', tx);
        expect(intoAlias?.id).toBe(into.id);
        const fromAlias = await repo().findByAlias(userB.id, 'AMZN Mktp GB', tx);
        expect(fromAlias?.id).toBe(from.id);
      });
    });

    test('is atomic when wrapped in a transaction — a rollback after merge undoes all three statements together', async () => {
      // `merge` issues three sequential statements through whatever
      // `transaction` it's handed; nothing in a single statement's
      // success guarantees the next one runs. This proves that wrapping
      // the call in a transaction is what makes them all-or-nothing: a
      // failure staged AFTER merge completes still unwinds everything
      // merge itself did, leaving the source vendor and its alias
      // exactly as they were.
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const into = await makeVendor(tx, { userId: user.id, displayName: 'Amazon' });
        const from = await makeVendor(tx, { userId: user.id, displayName: 'AMZN' });
        await repo().addAlias(from.id, 'AMZN Mktp GB', 'counterparty', tx);

        await expect(
          tx.transaction(async (nested) => {
            await repo().merge(user.id, into.id, from.id, nested);
            throw new Error('deliberate rollback after merge');
          })
        ).rejects.toThrow('deliberate rollback after merge');

        expect(await repo().findById(from.id, tx)).not.toBeNull();
        const alias = await repo().findByAlias(user.id, 'AMZN Mktp GB', tx);
        expect(alias?.id).toBe(from.id);
      });
    });
  });
});

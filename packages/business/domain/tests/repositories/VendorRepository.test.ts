import { describe, expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { normalizeVendorName } from '../../src/lib/normalize-vendor-name';
import { vendorMatchKey } from '../../src/lib/vendor-match-key';
import {
  VendorHasPaymentsError,
  VendorNameConflictError,
  VendorNotFoundError,
  VendorRepository,
} from '../../src/repositories/VendorRepository';
import { withTestDb } from '../../test/helpers/db';
import {
  makeDocument,
  makeDocumentExtraction,
  makeUser,
  makeVendor,
} from '../../test/helpers/factories';
import { makePayment, makePaymentOccurrence, makeToken } from '../../test/helpers/factories-extra';

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

    // The four below are the ones that were missing, and the reason the
    // break survived: every merge test above uses vendors with nothing
    // pointing at them, which is the one case where deleting the source
    // row outright happens to be correct.

    test("moves the source vendor's payments to the surviving vendor", async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const into = await makeVendor(tx, { userId: user.id, displayName: 'Amazon' });
        const from = await makeVendor(tx, { userId: user.id, displayName: 'AMZN' });
        const payment = await makePayment(tx, { userId: user.id, vendorId: from.id });

        await repo().merge(user.id, into.id, from.id, tx);

        const [moved] = await tx
          .select({ vendorId: schema.payments.vendorId })
          .from(schema.payments)
          .where(eq(schema.payments.id, payment.id));
        expect(moved?.vendorId).toBe(into.id);
      });
    });

    test('a vendor with payments can be merged at all', async () => {
      // Regression pin on the FK itself. `payments.vendor_id` is ON
      // DELETE RESTRICT, so a merge that deletes the source without
      // moving its payments first dies on `payments_vendor_id_fkey` —
      // and a vendor with no payments is not one anybody needs to merge.
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const into = await makeVendor(tx, { userId: user.id, displayName: 'Amazon' });
        const from = await makeVendor(tx, { userId: user.id, displayName: 'AMZN' });
        await makePayment(tx, { userId: user.id, vendorId: from.id });

        await expect(repo().merge(user.id, into.id, from.id, tx)).resolves.toBeUndefined();
        expect(await repo().findById(from.id, tx)).toBeNull();
      });
    });

    test("moves the source vendor's document extractions rather than nulling them", async () => {
      // `document_extractions.vendor_id` is ON DELETE SET NULL, so this
      // one failed silently: the merge succeeded and every extraction
      // resolved to the duplicate quietly lost its vendor.
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const into = await makeVendor(tx, { userId: user.id, displayName: 'Amazon' });
        const from = await makeVendor(tx, { userId: user.id, displayName: 'AMZN' });
        const document = await makeDocument(tx, { userId: user.id });
        const extraction = await makeDocumentExtraction(tx, {
          documentId: document.id,
          vendorId: from.id,
        });

        await repo().merge(user.id, into.id, from.id, tx);

        const [moved] = await tx
          .select({ vendorId: schema.documentExtractions.vendorId })
          .from(schema.documentExtractions)
          .where(eq(schema.documentExtractions.id, extraction.id));
        expect(moved?.vendorId).toBe(into.id);
      });
    });

    test('leaves the surviving vendor’s own payments alone', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const into = await makeVendor(tx, { userId: user.id, displayName: 'Amazon' });
        const from = await makeVendor(tx, { userId: user.id, displayName: 'AMZN' });
        const survivorPayment = await makePayment(tx, { userId: user.id, vendorId: into.id });
        await makePayment(tx, { userId: user.id, vendorId: from.id });

        await repo().merge(user.id, into.id, from.id, tx);

        const rows = await tx
          .select({ id: schema.payments.id })
          .from(schema.payments)
          .where(eq(schema.payments.vendorId, into.id));
        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.id)).toContain(survivorPayment.id);
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
  describe('mergeImpact', () => {
    test('counts the payments, aliases and extractions that would move', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const into = await makeVendor(tx, { userId: user.id, displayName: 'Amazon' });
        const from = await makeVendor(tx, { userId: user.id, displayName: 'AMZN' });
        await makePayment(tx, { userId: user.id, vendorId: from.id });
        await makePayment(tx, { userId: user.id, vendorId: from.id });
        await repo().addAlias(from.id, 'AMZN Mktp GB', 'counterparty', tx);
        const document = await makeDocument(tx, { userId: user.id });
        await makeDocumentExtraction(tx, { documentId: document.id, vendorId: from.id });

        const impact = await repo().mergeImpact(user.id, into.id, from.id, tx);

        expect(impact).toEqual({ payments: 2, aliases: 1, extractions: 1 });
      });
    });

    test('does not count an alias the surviving vendor already has', async () => {
      // `merge` dedupes that row away rather than reassigning it, so
      // counting it would promise the reader an alias that never arrives.
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const into = await makeVendor(tx, { userId: user.id, displayName: 'Amazon' });
        const from = await makeVendor(tx, { userId: user.id, displayName: 'AMZN' });
        await repo().addAlias(into.id, 'AMZN', 'manual', tx);
        await repo().addAlias(from.id, 'AMZN', 'manual', tx);
        await repo().addAlias(from.id, 'AMZN Mktp GB', 'counterparty', tx);

        const impact = await repo().mergeImpact(user.id, into.id, from.id, tx);

        expect(impact.aliases).toBe(1);
      });
    });

    test("refuses to describe a merge involving another user's vendor", async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const other = await makeUser(tx);
        const into = await makeVendor(tx, { userId: user.id, displayName: 'Amazon' });
        const foreign = await makeVendor(tx, { userId: other.id, displayName: 'Netflix' });

        await expect(repo().mergeImpact(user.id, into.id, foreign.id, tx)).rejects.toThrow(
          'must both belong to user'
        );
      });
    });

    test('reports zeroes for a vendor nothing points at', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const into = await makeVendor(tx, { userId: user.id, displayName: 'Amazon' });
        const from = await makeVendor(tx, { userId: user.id, displayName: 'AMZN' });

        expect(await repo().mergeImpact(user.id, into.id, from.id, tx)).toEqual({
          payments: 0,
          aliases: 0,
          extractions: 0,
        });
      });
    });
  });

  // "How much do I pay this vendor" (V3-53). The aggregate answers the
  // historical half of it, so what it must never do is count money that did
  // not move — a scheduled bill, a skipped one, or someone else's payment.
  describe('settledSpendByUser', () => {
    test('counts settled occurrences only, per currency and per direction', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const vendor = await makeVendor(tx, { userId: user.id, displayName: 'AWS' });
        const eur = await makeToken(tx);
        const gbp = await makeToken(tx);

        const inEur = await makePayment(tx, {
          userId: user.id,
          vendorId: vendor.id,
          currencyTokenId: eur.id,
          expectedAmount: '10',
        });
        const inGbp = await makePayment(tx, {
          userId: user.id,
          vendorId: vendor.id,
          currencyTokenId: gbp.id,
          expectedAmount: '30',
        });
        const income = await makePayment(tx, {
          userId: user.id,
          vendorId: vendor.id,
          currencyTokenId: eur.id,
          direction: 'inflow',
          expectedAmount: '900',
        });

        // In the window, out of it, and two that never moved.
        await makePaymentOccurrence(tx, {
          paymentId: inEur.id,
          dueDate: '2026-07-01',
          status: 'matched',
          actualAmount: '11',
        });
        await makePaymentOccurrence(tx, {
          paymentId: inEur.id,
          dueDate: '2020-01-01',
          status: 'matched',
          actualAmount: '9',
        });
        await makePaymentOccurrence(tx, {
          paymentId: inEur.id,
          dueDate: '2026-09-01',
          status: 'scheduled',
          expectedAmount: '10',
        });
        await makePaymentOccurrence(tx, {
          paymentId: inEur.id,
          dueDate: '2026-06-01',
          status: 'skipped',
          expectedAmount: '10',
        });
        await makePaymentOccurrence(tx, {
          paymentId: inGbp.id,
          dueDate: '2026-07-15',
          status: 'matched',
        });
        await makePaymentOccurrence(tx, {
          paymentId: income.id,
          dueDate: '2026-07-20',
          status: 'matched',
          actualAmount: '900',
        });

        const rows = await repo().settledSpendByUser(user.id, '2025-08-13', tx);
        const outEur = rows.find(
          (row) => row.currencyTokenId === eur.id && row.direction === 'outflow'
        );
        const outGbp = rows.find((row) => row.currencyTokenId === gbp.id);
        const inflow = rows.find((row) => row.direction === 'inflow');

        // 11 in the window, 9 outside it — the scheduled and skipped rows are
        // not money that moved and are in neither figure.
        expect(Number(outEur?.allTime)).toBe(20);
        expect(Number(outEur?.inWindow)).toBe(11);
        expect(outEur?.settledCount).toBe(2);
        // The GBP occurrence carries no amount of its own, so it falls back to
        // the payment's expected amount rather than counting as zero.
        expect(Number(outGbp?.allTime)).toBe(30);
        expect(outGbp?.unpricedCount).toBe(0);
        expect(Number(inflow?.allTime)).toBe(900);
      });
    });

    test('a settlement with no amount anywhere is counted, never summed as zero', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const vendor = await makeVendor(tx, { userId: user.id, displayName: 'Water' });
        const payment = await makePayment(tx, {
          userId: user.id,
          vendorId: vendor.id,
          kind: 'variable',
          expectedAmount: null,
        });
        await makePaymentOccurrence(tx, {
          paymentId: payment.id,
          dueDate: '2026-07-01',
          status: 'matched',
        });

        const [row] = await repo().settledSpendByUser(user.id, '2025-08-13', tx);
        expect(Number(row?.allTime)).toBe(0);
        expect(row?.settledCount).toBe(1);
        expect(row?.unpricedCount).toBe(1);
      });
    });

    test("never reaches another user's payments", async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const other = await makeUser(tx);
        const vendor = await makeVendor(tx, { userId: other.id, displayName: 'AWS' });
        const payment = await makePayment(tx, { userId: other.id, vendorId: vendor.id });
        await makePaymentOccurrence(tx, {
          paymentId: payment.id,
          dueDate: '2026-07-01',
          status: 'matched',
          actualAmount: '99',
        });

        expect(await repo().settledSpendByUser(user.id, '2025-08-13', tx)).toEqual([]);
      });
    });
  });

  describe('recentSettledByUser', () => {
    test('returns the newest N per vendor, newest first', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const vendor = await makeVendor(tx, { userId: user.id, displayName: 'AWS' });
        const other = await makeVendor(tx, { userId: user.id, displayName: 'Netflix' });
        const payment = await makePayment(tx, { userId: user.id, vendorId: vendor.id });
        const otherPayment = await makePayment(tx, { userId: user.id, vendorId: other.id });

        for (const dueDate of ['2026-01-01', '2026-02-01', '2026-03-01']) {
          await makePaymentOccurrence(tx, {
            paymentId: payment.id,
            dueDate,
            status: 'matched',
            actualAmount: '5',
          });
        }
        await makePaymentOccurrence(tx, {
          paymentId: payment.id,
          dueDate: '2026-04-01',
          status: 'scheduled',
        });
        await makePaymentOccurrence(tx, {
          paymentId: otherPayment.id,
          dueDate: '2026-05-01',
          status: 'matched',
          actualAmount: '7',
        });

        const rows = await repo().recentSettledByUser(user.id, 2, tx);
        // Two per vendor, and the scheduled April row is not a settlement.
        expect(rows.filter((row) => row.vendorId === vendor.id).map((row) => row.dueDate)).toEqual([
          '2026-03-01',
          '2026-02-01',
        ]);
        expect(rows.filter((row) => row.vendorId === other.id)).toHaveLength(1);
      });
    });
  });
});

// The near-duplicate tiers (V3-49). Exact matching was the whole of vendor
// resolution, so "Hetzner Online GmbH" and "Hetzner Online" were two vendors
// and the user merged them by hand. The pairs below are the real ones, tested
// in BOTH directions — which name got there first is an accident of whichever
// extractor ran first — plus the case that decides the threshold: two
// different companies sharing a first word, which must never auto-reuse.
describe('VendorRepository near-duplicate resolution', () => {
  test('exact tiers still win, and still report themselves as exact', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const vendor = await makeVendor(tx, { userId: user.id, displayName: 'Amazon' });
      await repo().addAlias(vendor.id, 'AMZN Mktp GB', 'counterparty', tx);

      const byName = await repo().resolve(user.id, 'amazon', tx);
      expect(byName).toMatchObject({ tier: 'exact', score: 1 });
      expect(byName?.vendor.id).toBe(vendor.id);

      const byAlias = await repo().resolve(user.id, 'AMZN Mktp GB', tx);
      expect(byAlias).toMatchObject({ tier: 'exact', score: 1 });
      expect(byAlias?.vendor.id).toBe(vendor.id);
    });
  });

  test('a differing legal suffix resolves to the same vendor, both directions', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const long = await makeVendor(tx, { userId: user.id, displayName: 'Hetzner Online GmbH' });

      const short = await repo().resolve(user.id, 'Hetzner Online', tx);
      expect(short?.vendor.id).toBe(long.id);
      expect(short?.tier).toBe('canonical');
    });

    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const short = await makeVendor(tx, { userId: user.id, displayName: 'Hetzner Online' });

      const long = await repo().resolve(user.id, 'Hetzner Online GmbH', tx);
      expect(long?.vendor.id).toBe(short.id);
      expect(long?.tier).toBe('canonical');
    });
  });

  test('punctuation around the legal form resolves too', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const vendor = await makeVendor(tx, { userId: user.id, displayName: 'Fly.io, Inc.' });

      const match = await repo().resolve(user.id, 'Fly.io', tx);
      expect(match?.vendor.id).toBe(vendor.id);
      expect(match?.tier).toBe('canonical');
    });
  });

  test('a near-identical string is reused silently; a merely similar one is not', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const vendor = await makeVendor(tx, {
        userId: user.id,
        displayName: 'Hetzner Online Deutschland',
      });

      // 0.893 — one dropped character on a long name, above the 0.85 bar.
      const typo = await repo().resolve(user.id, 'Hetzner Online Deutschlan', tx);
      expect(typo?.vendor.id).toBe(vendor.id);
      expect(typo?.tier).toBe('similar');
      expect(typo?.score).toBeGreaterThanOrEqual(0.85);
    });

    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await makeVendor(tx, { userId: user.id, displayName: 'Amazon Web Services' });

      // 0.714 — a truncation, plainly the same company to a human, and still
      // not enough to attach a bill without asking.
      expect(await repo().resolve(user.id, 'Amazon Web Serv', tx)).toBeUndefined();

      const candidates = await repo().findCandidates(user.id, 'Amazon Web Serv', {}, tx);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.vendor.displayName).toBe('Amazon Web Services');
      expect(candidates[0]?.autoReuse).toBe(false);
    });
  });

  // The case that sets the threshold. "Apple" and "Apple Bank" score 0.545 —
  // higher than a real typo on a short name ("anthropic"/"anthropc", 0.583 is
  // barely above it) — so no trigram threshold separates them and the only
  // safe answer is to ask.
  test('two different companies sharing a first word are never auto-reused', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await makeVendor(tx, { userId: user.id, displayName: 'Apple Bank' });

      expect(await repo().resolve(user.id, 'Apple', tx)).toBeUndefined();

      const candidates = await repo().findCandidates(user.id, 'Apple', {}, tx);
      expect(candidates[0]?.vendor.displayName).toBe('Apple Bank');
      expect(candidates[0]?.autoReuse).toBe(false);
    });
  });

  test('a shared first word and nothing else is not even suggested', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await makeVendor(tx, { userId: user.id, displayName: 'Deutsche Telekom' });

      expect(await repo().resolve(user.id, 'Deutsche Bank', tx)).toBeUndefined();
      expect(await repo().findCandidates(user.id, 'Deutsche Bank', {}, tx)).toEqual([]);
    });
  });

  test("another user's near-duplicate is invisible", async () => {
    await withTestDb(async (tx) => {
      const mine = await makeUser(tx);
      const theirs = await makeUser(tx);
      await makeVendor(tx, { userId: theirs.id, displayName: 'Hetzner Online GmbH' });

      expect(await repo().resolve(mine.id, 'Hetzner Online', tx)).toBeUndefined();
      expect(await repo().findCandidates(mine.id, 'Hetzner Online', {}, tx)).toEqual([]);
    });
  });

  test('createForUser derives both keys from one normalisation', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const vendor = await repo().createForUser(user.id, { displayName: '  Fly.io, Inc.  ' }, tx);

      expect(vendor.displayName).toBe('Fly.io, Inc.');
      expect(vendor.normalizedName).toBe(normalizeVendorName('Fly.io, Inc.'));
      expect(vendor.matchKey).toBe(vendorMatchKey('Fly.io, Inc.'));
    });
  });

  // `match_key` is a GENERATED column: Postgres derives it from
  // `normalized_name` with four nested `regexp_replace` calls, and
  // `vendorMatchKey` computes the same key in TypeScript for the string being
  // searched FOR. Those are two implementations of one definition, and the
  // only place they can drift. A drift would be silent — matching would simply
  // stop finding things — so it is tested against the live column rather than
  // trusted.
  test('the generated match_key column agrees with vendorMatchKey', async () => {
    const names = [
      'Hetzner Online GmbH',
      'Hetzner Online',
      'Fly.io, Inc.',
      'Acme S.à r.l.',
      'Muster GmbH & Co. KG',
      'Sklep Sp. z o.o.',
      'Taco Bell',
      'Ltd',
      'Deutsche Bank',
      'SQ *Acme Ltd',
    ];

    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      for (const name of names) {
        const vendor = await repo().createForUser(user.id, { displayName: name }, tx);
        expect(vendor.matchKey).toBe(vendorMatchKey(name));
      }
    });
  });

  // The column has to be invisible to a writer that predates it — nothing
  // outside this file names it, and a plain INSERT must keep working.
  test('a vendor insert that never mentions match_key still gets one', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const [row] = await tx
        .insert(schema.vendors)
        .values({
          userId: user.id,
          displayName: 'Hetzner Online GmbH',
          normalizedName: normalizeVendorName('Hetzner Online GmbH'),
        })
        .returning();

      expect(row?.matchKey).toBe('hetzner online');
    });
  });

  // SC-83. `update` and `delete` are the two write paths this repository did
  // not have, and both of them are about what happens to everything ELSE
  // pointing at the row — the derived columns for a rename, and the FKs for a
  // delete. Every test below is about that half.
  describe('updateForUser', () => {
    test('a rename recomputes normalizedName and, through it, matchKey', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const vendor = await repo().createForUser(user.id, { displayName: 'Acme' }, tx);

        const renamed = await repo().updateForUser(
          user.id,
          vendor.id,
          { displayName: '  Hetzner Online GmbH  ' },
          tx
        );

        expect(renamed.displayName).toBe('Hetzner Online GmbH');
        expect(renamed.normalizedName).toBe(normalizeVendorName('Hetzner Online GmbH'));
        // GENERATED ALWAYS — Postgres recomputed it as part of the UPDATE,
        // which is the only reason the exact-match tier stays correct.
        expect(renamed.matchKey).toBe(vendorMatchKey('Hetzner Online GmbH'));
      });
    });

    test('a rename leaves the aliases alone', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const vendor = await repo().createForUser(user.id, { displayName: 'Amazon' }, tx);
        await repo().addAlias(vendor.id, 'AMZN Mktp GB', 'counterparty', tx);

        await repo().updateForUser(user.id, vendor.id, { displayName: 'Amazon EU' }, tx);

        // The raw string is still true, so the match it drives must survive.
        const found = await repo().findByAlias(user.id, 'AMZN Mktp GB', tx);
        expect(found?.id).toBe(vendor.id);
      });
    });

    test('recasing to the same normalized name is allowed, not a self-collision', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const vendor = await repo().createForUser(user.id, { displayName: 'aws' }, tx);

        const renamed = await repo().updateForUser(user.id, vendor.id, { displayName: 'AWS' }, tx);
        expect(renamed.displayName).toBe('AWS');
      });
    });

    test('renaming onto another vendor refuses and names the survivor', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const keep = await repo().createForUser(user.id, { displayName: 'Netflix' }, tx);
        const other = await repo().createForUser(user.id, { displayName: 'Spotify' }, tx);

        const attempt = repo().updateForUser(user.id, other.id, { displayName: 'netflix' }, tx);
        await expect(attempt).rejects.toThrow(VendorNameConflictError);

        // The refusal has to carry the other vendor, or the surface can only
        // say "that name is taken" and the reader cannot act on it.
        const error = await attempt.catch((thrown: unknown) => thrown);
        expect((error as VendorNameConflictError).conflictingVendorId).toBe(keep.id);

        // And it refused rather than half-applying.
        const unchanged = await repo().findById(other.id, tx);
        expect(unchanged?.displayName).toBe('Spotify');
      });
    });

    test("another user's vendor is not found, not forbidden", async () => {
      await withTestDb(async (tx) => {
        const owner = await makeUser(tx);
        const stranger = await makeUser(tx);
        const vendor = await repo().createForUser(owner.id, { displayName: 'Netflix' }, tx);

        await expect(
          repo().updateForUser(stranger.id, vendor.id, { displayName: 'Mine now' }, tx)
        ).rejects.toThrow(VendorNotFoundError);

        const untouched = await repo().findById(vendor.id, tx);
        expect(untouched?.displayName).toBe('Netflix');
      });
    });

    test('a name collision with ANOTHER user is not a collision', async () => {
      await withTestDb(async (tx) => {
        const userA = await makeUser(tx);
        const userB = await makeUser(tx);
        await repo().createForUser(userA.id, { displayName: 'Netflix' }, tx);
        const mine = await repo().createForUser(userB.id, { displayName: 'Spotify' }, tx);

        const renamed = await repo().updateForUser(
          userB.id,
          mine.id,
          { displayName: 'Netflix' },
          tx
        );
        expect(renamed.displayName).toBe('Netflix');
      });
    });

    test('category and website can be cleared without touching the name', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const vendor = await repo().createForUser(
          user.id,
          { displayName: 'Hetzner', category: 'Hosting', website: 'https://hetzner.com' },
          tx
        );

        const updated = await repo().updateForUser(
          user.id,
          vendor.id,
          { category: null, website: null },
          tx
        );

        expect(updated.category).toBeNull();
        expect(updated.website).toBeNull();
        expect(updated.displayName).toBe('Hetzner');
      });
    });
  });

  describe('deleteForUser', () => {
    test('refuses while a payment points at it, and deletes nothing', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const vendor = await makeVendor(tx, { userId: user.id, displayName: 'Netflix' });
        await makePayment(tx, { userId: user.id, vendorId: vendor.id });

        const attempt = repo().deleteForUser(user.id, vendor.id, tx);
        await expect(attempt).rejects.toThrow(VendorHasPaymentsError);

        // The count is the whole point of refusing rather than letting the FK
        // do it — `payments_vendor_id_fkey` cannot say "1".
        const error = await attempt.catch((thrown: unknown) => thrown);
        expect((error as VendorHasPaymentsError).paymentCount).toBe(1);

        expect(await repo().findById(vendor.id, tx)).not.toBeNull();
      });
    });

    test('deletes a vendor nothing points at, and takes its aliases with it', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const vendor = await makeVendor(tx, { userId: user.id, displayName: 'Typo Ltd' });
        await repo().addAlias(vendor.id, 'TYPO LTD', 'manual', tx);

        const impact = await repo().deleteForUser(user.id, vendor.id, tx);
        expect(impact).toEqual({ payments: 0, aliases: 1, extractions: 0 });

        expect(await repo().findById(vendor.id, tx)).toBeNull();
        const aliases = await tx
          .select()
          .from(schema.vendorAliases)
          .where(eq(schema.vendorAliases.vendorId, vendor.id));
        expect(aliases).toHaveLength(0);
      });
    });

    test('an extraction survives the delete with its raw name and a null link', async () => {
      await withTestDb(async (tx) => {
        const user = await makeUser(tx);
        const vendor = await makeVendor(tx, { userId: user.id, displayName: 'Wrong Name GmbH' });
        const document = await makeDocument(tx, { userId: user.id });
        const extraction = await makeDocumentExtraction(tx, {
          documentId: document.id,
          vendorId: vendor.id,
          vendorNameRaw: 'WRONG NAME GMBH',
        });

        // The count has to be reported, because ON DELETE SET NULL cuts this
        // link silently — the half of the SC-31 bug that "succeeded".
        const impact = await repo().deleteForUser(user.id, vendor.id, tx);
        expect(impact.extractions).toBe(1);

        const [after] = await tx
          .select()
          .from(schema.documentExtractions)
          .where(eq(schema.documentExtractions.id, extraction.id));
        expect(after?.vendorId).toBeNull();
        expect(after?.vendorNameRaw).toBe('WRONG NAME GMBH');
      });
    });

    test("another user's vendor is not found, and is not deleted", async () => {
      await withTestDb(async (tx) => {
        const owner = await makeUser(tx);
        const stranger = await makeUser(tx);
        const vendor = await makeVendor(tx, { userId: owner.id, displayName: 'Netflix' });

        await expect(repo().deleteForUser(stranger.id, vendor.id, tx)).rejects.toThrow(
          VendorNotFoundError
        );
        expect(await repo().findById(vendor.id, tx)).not.toBeNull();
      });
    });
  });
});

import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { GroupRepository } from '../../../src/repositories/GroupRepository';
import { PaymentOccurrenceRepository } from '../../../src/repositories/PaymentOccurrenceRepository';
import { VendorRepository } from '../../../src/repositories/VendorRepository';
import { PaymentGroupService } from '../../../src/services/payments/PaymentGroupService';
import { PaymentService } from '../../../src/services/payments/PaymentService';
import { withTestDb } from '../../../test/helpers/db';
import { makeUser, makeVendor } from '../../../test/helpers/factories';
import { makePayment, makePaymentOccurrence } from '../../../test/helpers/factories-extra';

const groups = () => Container.get(PaymentGroupService);
const payments = () => Container.get(PaymentService);
const occurrences = () => Container.get(PaymentOccurrenceRepository);

function dayFromToday(offset: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset))
    .toISOString()
    .slice(0, 10);
}

async function makeGroup(tx: DatabaseTransaction, userId: string, name = 'Home') {
  const [group] = await tx
    .insert(schema.groups)
    .values({ userId, name, color: '#123456' })
    .returning();
  return group!;
}

/** The groups each of these bills is in, as `resolve` answers it. */
async function billGroups(tx: DatabaseTransaction, userId: string, ids: string[]) {
  const membership = await groups().resolve(userId, tx);
  return ids.map((id) => [...(membership.get(id)?.keys() ?? [])].sort());
}

async function occurrenceGroups(tx: DatabaseTransaction, occurrenceId: string) {
  const rows = await tx
    .select({ groupId: schema.paymentOccurrenceGroups.groupId })
    .from(schema.paymentOccurrenceGroups)
    .where(eq(schema.paymentOccurrenceGroups.occurrenceId, occurrenceId));
  return rows.map((row) => row.groupId);
}

describe('a payee in a group (SC-1408)', () => {
  test('puts every bill for that payee in it, including one added later', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const vendor = await makeVendor(tx, { userId: user.id });
      const home = await makeGroup(tx, user.id);
      const before = await makePayment(tx, { userId: user.id, vendorId: vendor.id });
      const other = await makePayment(tx, { userId: user.id });

      await groups().changeMembership(
        user.id,
        home.id,
        { vendorIds: [vendor.id], paymentIds: [] },
        'add',
        tx
      );
      const later = await payments().create(
        user.id,
        {
          vendorId: vendor.id,
          direction: 'outflow',
          kind: 'fixed',
          currencyTokenId: before.currencyTokenId,
          intervalUnit: 'month',
          intervalCount: 1,
          anchorDate: dayFromToday(3),
        },
        tx
      );

      expect(await billGroups(tx, user.id, [before.id, later.id, other.id])).toEqual([
        [home.id],
        [home.id],
        [],
      ]);
      const [first] = await occurrences().findByPaymentId(later.id, tx);
      expect(await occurrenceGroups(tx, first!.id)).toEqual([home.id]);
      expect((await groups().resolve(user.id, tx)).get(later.id)?.get(home.id)).toBe('payee');
    });
  });

  test('a bill can opt out of its payee’s group, and opting back in writes no row of its own', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const vendor = await makeVendor(tx, { userId: user.id });
      const home = await makeGroup(tx, user.id);
      const kept = await makePayment(tx, { userId: user.id, vendorId: vendor.id });
      const opted = await makePayment(tx, { userId: user.id, vendorId: vendor.id });
      await groups().changeMembership(
        user.id,
        home.id,
        { vendorIds: [vendor.id], paymentIds: [] },
        'add',
        tx
      );

      await payments().assignGroups(user.id, { paymentId: opted.id, groupIds: [] }, tx);
      expect(await billGroups(tx, user.id, [kept.id, opted.id])).toEqual([[home.id], []]);

      await payments().assignGroups(user.id, { paymentId: opted.id, groupIds: [home.id] }, tx);
      expect(await billGroups(tx, user.id, [opted.id])).toEqual([[home.id]]);
      const direct = await tx
        .select()
        .from(schema.paymentGroups)
        .where(eq(schema.paymentGroups.paymentId, opted.id));
      expect(direct).toEqual([]);

      // Removing the rule now takes the bill out with it, because nothing
      // but the rule ever put it in.
      await groups().changeMembership(
        user.id,
        home.id,
        { vendorIds: [vendor.id], paymentIds: [] },
        'remove',
        tx
      );
      expect(await billGroups(tx, user.id, [kept.id, opted.id])).toEqual([[], []]);
    });
  });

  test('removing one bill the rule covers excludes it; adding it back clears that', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const vendor = await makeVendor(tx, { userId: user.id });
      const home = await makeGroup(tx, user.id);
      const bill = await makePayment(tx, { userId: user.id, vendorId: vendor.id });
      const change = (paymentIds: string[], vendorIds: string[], direction: 'add' | 'remove') =>
        groups().changeMembership(user.id, home.id, { vendorIds, paymentIds }, direction, tx);

      await change([], [vendor.id], 'add');
      await change([bill.id], [], 'remove');
      expect(await groups().groupBills(user.id, home.id, tx)).toEqual({
        payees: [vendor.id],
        bills: [],
        excluded: [bill.id],
      });

      await change([bill.id], [], 'add');
      expect(await groups().groupBills(user.id, home.id, tx)).toEqual({
        payees: [vendor.id],
        bills: [{ paymentId: bill.id, source: 'direct' }],
        excluded: [],
      });
    });
  });

  test('a rule change re-tags upcoming occurrences and leaves paid ones alone', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const vendor = await makeVendor(tx, { userId: user.id });
      const home = await makeGroup(tx, user.id);
      const bill = await makePayment(tx, { userId: user.id, vendorId: vendor.id });
      const paid = await makePaymentOccurrence(tx, {
        paymentId: bill.id,
        dueDate: dayFromToday(-20),
        status: 'matched',
      });
      const upcoming = await makePaymentOccurrence(tx, {
        paymentId: bill.id,
        dueDate: dayFromToday(10),
      });
      const overridden = await makePaymentOccurrence(tx, {
        paymentId: bill.id,
        dueDate: dayFromToday(40),
        groupsOverridden: true,
      });
      const change = (direction: 'add' | 'remove') =>
        groups().changeMembership(
          user.id,
          home.id,
          { vendorIds: [vendor.id], paymentIds: [] },
          direction,
          tx
        );

      await change('add');
      expect(await occurrenceGroups(tx, upcoming.id)).toEqual([home.id]);
      expect(await occurrenceGroups(tx, paid.id)).toEqual([]);
      expect(await occurrenceGroups(tx, overridden.id)).toEqual([]);

      await tx
        .insert(schema.paymentOccurrenceGroups)
        .values({ occurrenceId: paid.id, groupId: home.id });
      await change('remove');
      expect(await occurrenceGroups(tx, upcoming.id)).toEqual([]);
      expect(await occurrenceGroups(tx, paid.id)).toEqual([home.id]);
    });
  });

  test('another user’s group, payee or bill is refused and nothing changes', async () => {
    await withTestDb(async (tx) => {
      const owner = await makeUser(tx);
      const stranger = await makeUser(tx);
      const home = await makeGroup(tx, owner.id);
      const theirs = await makeGroup(tx, stranger.id, 'Theirs');
      const vendor = await makeVendor(tx, { userId: owner.id });
      const foreignVendor = await makeVendor(tx, { userId: stranger.id });
      const foreignBill = await makePayment(tx, { userId: stranger.id });
      const attempt = (
        userId: string,
        groupId: string,
        vendorIds: string[],
        paymentIds: string[]
      ) =>
        tx.transaction((nested) =>
          groups().changeMembership(userId, groupId, { vendorIds, paymentIds }, 'add', nested)
        );

      await expect(attempt(owner.id, theirs.id, [vendor.id], [])).rejects.toThrow(
        'Group not found'
      );
      await expect(attempt(owner.id, home.id, [vendor.id, foreignVendor.id], [])).rejects.toThrow(
        'Vendor not found'
      );
      await expect(attempt(owner.id, home.id, [], [foreignBill.id])).rejects.toThrow(
        'Payment not found'
      );
      expect(await tx.select().from(schema.vendorGroups)).toEqual([]);
      expect(await tx.select().from(schema.paymentGroups)).toEqual([]);
    });
  });

  test('a rule on another user’s group is ignored rather than trusted', async () => {
    await withTestDb(async (tx) => {
      const owner = await makeUser(tx);
      const stranger = await makeUser(tx);
      const vendor = await makeVendor(tx, { userId: owner.id });
      const bill = await makePayment(tx, { userId: owner.id, vendorId: vendor.id });
      const theirs = await makeGroup(tx, stranger.id, 'Theirs');
      await tx.insert(schema.vendorGroups).values({ vendorId: vendor.id, groupId: theirs.id });
      expect(await billGroups(tx, owner.id, [bill.id])).toEqual([[]]);
      expect(await groups().payeeRules(owner.id, tx)).toEqual({});
    });
  });

  test('merging payees keeps the merged one’s rules', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const into = await makeVendor(tx, { userId: user.id });
      const from = await makeVendor(tx, { userId: user.id });
      const home = await makeGroup(tx, user.id);
      const bill = await makePayment(tx, { userId: user.id, vendorId: into.id });
      const upcoming = await makePaymentOccurrence(tx, {
        paymentId: bill.id,
        dueDate: dayFromToday(5),
      });
      await groups().changeMembership(
        user.id,
        home.id,
        { vendorIds: [from.id], paymentIds: [] },
        'add',
        tx
      );

      await Container.get(VendorRepository).merge(user.id, into.id, from.id, tx);
      await groups().retagPayee(user.id, into.id, tx);

      expect(await groups().payeeRules(user.id, tx)).toEqual({ [into.id]: [home.id] });
      expect(await billGroups(tx, user.id, [bill.id])).toEqual([[home.id]]);
      expect(await occurrenceGroups(tx, upcoming.id)).toEqual([home.id]);
    });
  });

  test('the groups list counts the bills and payees the group page lists', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const vendor = await makeVendor(tx, { userId: user.id });
      const home = await makeGroup(tx, user.id);
      const covered = await makePayment(tx, { userId: user.id, vendorId: vendor.id });
      const opted = await makePayment(tx, { userId: user.id, vendorId: vendor.id });
      const own = await makePayment(tx, { userId: user.id });
      const change = (vendorIds: string[], paymentIds: string[], direction: 'add' | 'remove') =>
        groups().changeMembership(user.id, home.id, { vendorIds, paymentIds }, direction, tx);
      await change([vendor.id], [own.id], 'add');
      await change([], [opted.id], 'remove');

      const page = await groups().groupBills(user.id, home.id, tx);
      const [counted] = (
        await Container.get(GroupRepository).findByUserWithCounts(user.id, tx)
      ).filter((group) => group.id === home.id);
      expect(page.bills.map((bill) => bill.paymentId).sort()).toEqual([covered.id, own.id].sort());
      expect(counted?.billsCount).toBe(page.bills.length);
      expect(counted?.payeesCount).toBe(page.payees.length);
    });
  });
});

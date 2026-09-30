import { type DatabaseTransaction, getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { type AnyColumn, and, eq, gte, inArray } from 'drizzle-orm';
import { Service } from 'typedi';

export type BillGroupSource = 'direct' | 'payee';

/**
 * Which groups a bill is in, and the rule that put it there (SC-1408).
 *
 * Payees play the part accounts play for holdings (SC-386). A bill is in a
 * group three ways, resolved by `resolve` and nowhere else:
 *
 *   1. **by its own row** — `payment_groups`
 *   2. **via its payee** — `vendor_groups` on the bill's `vendor_id`, a
 *      standing rule that covers every bill with that payee, including bills
 *      added later
 *   3. **explicitly out** — `payment_group_exclusions`, which beats both
 *
 *     (payment_groups ∪ via payee) − exclusions
 *
 * Occurrences carry their own tags (`payment_occurrence_groups`) because a
 * paid or missed month keeps the groups it had. So a membership change
 * re-tags only the FUTURE scheduled occurrences that have no override of
 * their own, and history is never rewritten.
 *
 * A group counts only when it belongs to the bill's owner, the same guard
 * `GroupRepository.resolveMembership` keeps for holdings (SC-1286).
 */
@Service()
export class PaymentGroupService {
  async resolve(
    userId: string,
    transaction?: DatabaseTransaction,
    paymentIds?: readonly string[]
  ): Promise<Map<string, Map<string, BillGroupSource>>> {
    const database = transaction ?? getDb();
    if (paymentIds?.length === 0) return new Map();
    const scope = paymentIds
      ? and(eq(schema.payments.userId, userId), inArray(schema.payments.id, [...paymentIds]))
      : eq(schema.payments.userId, userId);
    const ownedGroup = (groupId: AnyColumn) =>
      and(eq(schema.groups.id, groupId), eq(schema.groups.userId, schema.payments.userId));
    const direct = await database
      .select({ paymentId: schema.paymentGroups.paymentId, groupId: schema.paymentGroups.groupId })
      .from(schema.paymentGroups)
      .innerJoin(schema.payments, eq(schema.payments.id, schema.paymentGroups.paymentId))
      .innerJoin(schema.groups, ownedGroup(schema.paymentGroups.groupId))
      .where(scope);
    const viaPayee = await database
      .select({ paymentId: schema.payments.id, groupId: schema.vendorGroups.groupId })
      .from(schema.payments)
      .innerJoin(schema.vendorGroups, eq(schema.vendorGroups.vendorId, schema.payments.vendorId))
      .innerJoin(schema.groups, ownedGroup(schema.vendorGroups.groupId))
      .where(scope);
    const excluded = await database
      .select({
        paymentId: schema.paymentGroupExclusions.paymentId,
        groupId: schema.paymentGroupExclusions.groupId,
      })
      .from(schema.paymentGroupExclusions)
      .innerJoin(schema.payments, eq(schema.payments.id, schema.paymentGroupExclusions.paymentId))
      .where(scope);

    const vetoed = new Set(excluded.map((row) => `${row.paymentId}:${row.groupId}`));
    const out = new Map<string, Map<string, BillGroupSource>>();
    const add = (row: { paymentId: string; groupId: string }, source: BillGroupSource) => {
      if (vetoed.has(`${row.paymentId}:${row.groupId}`)) return;
      const groups = out.get(row.paymentId) ?? new Map<string, BillGroupSource>();
      if (!groups.has(row.groupId)) groups.set(row.groupId, source);
      out.set(row.paymentId, groups);
    };
    for (const row of direct) add(row, 'direct');
    for (const row of viaPayee) add(row, 'payee');
    return out;
  }

  /** Payee → the groups its rule puts every bill in. */
  async payeeRules(
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<Record<string, string[]>> {
    const database = transaction ?? getDb();
    const rows = await database
      .select({ vendorId: schema.vendorGroups.vendorId, groupId: schema.vendorGroups.groupId })
      .from(schema.vendorGroups)
      .innerJoin(schema.vendors, eq(schema.vendors.id, schema.vendorGroups.vendorId))
      .innerJoin(
        schema.groups,
        and(
          eq(schema.groups.id, schema.vendorGroups.groupId),
          eq(schema.groups.userId, schema.vendors.userId)
        )
      )
      .where(eq(schema.vendors.userId, userId));
    const out: Record<string, string[]> = {};
    for (const row of rows) out[row.vendorId] = [...(out[row.vendorId] ?? []), row.groupId];
    return out;
  }

  /**
   * Make `groupIds` the bill's groups, whatever put it in them. A group its
   * payee's rule already covers needs no row of its own, so removing the rule
   * later takes the bill out with it; unticking one writes the exclusion.
   * Ownership of the payment and the groups is the caller's to have checked.
   */
  async setBillGroups(
    payment: { id: string; userId: string; vendorId: string },
    groupIds: readonly string[],
    transaction: DatabaseTransaction
  ): Promise<void> {
    const wanted = new Set(groupIds);
    const covered = new Set(
      (await this.payeeRules(payment.userId, transaction))[payment.vendorId] ?? []
    );
    await transaction
      .delete(schema.paymentGroups)
      .where(eq(schema.paymentGroups.paymentId, payment.id));
    await transaction
      .delete(schema.paymentGroupExclusions)
      .where(eq(schema.paymentGroupExclusions.paymentId, payment.id));
    const direct = [...wanted].filter((groupId) => !covered.has(groupId));
    const vetoed = [...covered].filter((groupId) => !wanted.has(groupId));
    if (direct.length)
      await transaction
        .insert(schema.paymentGroups)
        .values(direct.map((groupId) => ({ paymentId: payment.id, groupId })));
    if (vetoed.length)
      await transaction
        .insert(schema.paymentGroupExclusions)
        .values(vetoed.map((groupId) => ({ paymentId: payment.id, groupId })));
    await this.retagFuture(payment.userId, [payment.id], transaction);
  }

  /**
   * Add or remove payees (as rules) and single bills in one group.
   *
   * Adding a payee clears that group's exclusions on the payee's bills, and so
   * does removing it: an exclusion only means something while the rule it
   * opts out of exists, the same reasoning `account_groups` follows (SC-386).
   * Removing a single bill that is in by its payee writes an exclusion.
   */
  async changeMembership(
    userId: string,
    groupId: string,
    members: { vendorIds: readonly string[]; paymentIds: readonly string[] },
    direction: 'add' | 'remove',
    transaction?: DatabaseTransaction
  ): Promise<void> {
    if (!transaction)
      return getDb().transaction((tx) =>
        this.changeMembership(userId, groupId, members, direction, tx)
      );
    const vendorIds = [...new Set(members.vendorIds)];
    const paymentIds = [...new Set(members.paymentIds)];
    const [group] = await transaction
      .select({ id: schema.groups.id })
      .from(schema.groups)
      .where(and(eq(schema.groups.id, groupId), eq(schema.groups.userId, userId)))
      .for('update');
    if (!group) throw new Error('Group not found');
    if (vendorIds.length) {
      const owned = await transaction
        .select({ id: schema.vendors.id })
        .from(schema.vendors)
        .where(and(eq(schema.vendors.userId, userId), inArray(schema.vendors.id, vendorIds)));
      if (owned.length !== vendorIds.length) throw new Error('Vendor not found');
    }
    const bills = paymentIds.length
      ? await transaction
          .select({ id: schema.payments.id, vendorId: schema.payments.vendorId })
          .from(schema.payments)
          .where(and(eq(schema.payments.userId, userId), inArray(schema.payments.id, paymentIds)))
          .orderBy(schema.payments.id)
          .for('update')
      : [];
    if (bills.length !== paymentIds.length) throw new Error('Payment not found');

    const payeeBills = vendorIds.length
      ? (
          await transaction
            .select({ id: schema.payments.id })
            .from(schema.payments)
            .where(
              and(eq(schema.payments.userId, userId), inArray(schema.payments.vendorId, vendorIds))
            )
        ).map((row) => row.id)
      : [];
    if (vendorIds.length) {
      if (direction === 'add')
        await transaction
          .insert(schema.vendorGroups)
          .values(vendorIds.map((vendorId) => ({ vendorId, groupId })))
          .onConflictDoNothing();
      else
        await transaction
          .delete(schema.vendorGroups)
          .where(
            and(
              eq(schema.vendorGroups.groupId, groupId),
              inArray(schema.vendorGroups.vendorId, vendorIds)
            )
          );
      if (payeeBills.length)
        await transaction
          .delete(schema.paymentGroupExclusions)
          .where(
            and(
              eq(schema.paymentGroupExclusions.groupId, groupId),
              inArray(schema.paymentGroupExclusions.paymentId, payeeBills)
            )
          );
    }

    if (bills.length) {
      const ids = bills.map((bill) => bill.id);
      if (direction === 'add') {
        await transaction
          .delete(schema.paymentGroupExclusions)
          .where(
            and(
              eq(schema.paymentGroupExclusions.groupId, groupId),
              inArray(schema.paymentGroupExclusions.paymentId, ids)
            )
          );
        await transaction
          .insert(schema.paymentGroups)
          .values(ids.map((paymentId) => ({ paymentId, groupId })))
          .onConflictDoNothing();
      } else {
        await transaction
          .delete(schema.paymentGroups)
          .where(
            and(
              eq(schema.paymentGroups.groupId, groupId),
              inArray(schema.paymentGroups.paymentId, ids)
            )
          );
        const ruled = new Set(
          (
            await transaction
              .select({ vendorId: schema.vendorGroups.vendorId })
              .from(schema.vendorGroups)
              .where(eq(schema.vendorGroups.groupId, groupId))
          ).map((row) => row.vendorId)
        );
        const vetoed = bills.filter((bill) => ruled.has(bill.vendorId));
        if (vetoed.length)
          await transaction
            .insert(schema.paymentGroupExclusions)
            .values(vetoed.map((bill) => ({ paymentId: bill.id, groupId })))
            .onConflictDoNothing();
      }
    }
    await this.retagFuture(userId, [...new Set([...payeeBills, ...paymentIds])], transaction);
  }

  /** What a group's page lists: its payee rules, its bills and why each is
   *  in, and the bills a rule would include but an exclusion keeps out. */
  async groupBills(userId: string, groupId: string, transaction?: DatabaseTransaction) {
    const database = transaction ?? getDb();
    const [group] = await database
      .select({ id: schema.groups.id })
      .from(schema.groups)
      .where(and(eq(schema.groups.id, groupId), eq(schema.groups.userId, userId)));
    if (!group) throw new Error('Group not found');
    const rules = await this.payeeRules(userId, database);
    const payees = Object.keys(rules).filter((vendorId) => rules[vendorId]!.includes(groupId));
    const membership = await this.resolve(userId, database);
    const bills: { paymentId: string; source: BillGroupSource }[] = [];
    for (const [paymentId, groups] of membership) {
      const source = groups.get(groupId);
      if (source) bills.push({ paymentId, source });
    }
    const excluded = await database
      .select({ paymentId: schema.paymentGroupExclusions.paymentId })
      .from(schema.paymentGroupExclusions)
      .innerJoin(schema.payments, eq(schema.payments.id, schema.paymentGroupExclusions.paymentId))
      .where(
        and(eq(schema.paymentGroupExclusions.groupId, groupId), eq(schema.payments.userId, userId))
      );
    return { payees, bills, excluded: excluded.map((row) => row.paymentId) };
  }

  /**
   * Point every future scheduled occurrence without its own override at its
   * bill's groups. Paid, missed and past rows keep the groups they had.
   */
  async retagFuture(
    userId: string,
    paymentIds: readonly string[],
    transaction: DatabaseTransaction
  ): Promise<void> {
    if (paymentIds.length === 0) return;
    const occurrences = await transaction
      .select({ id: schema.paymentOccurrences.id, paymentId: schema.paymentOccurrences.paymentId })
      .from(schema.paymentOccurrences)
      .where(
        and(
          inArray(schema.paymentOccurrences.paymentId, [...paymentIds]),
          eq(schema.paymentOccurrences.status, 'scheduled'),
          eq(schema.paymentOccurrences.groupsOverridden, false),
          gte(schema.paymentOccurrences.dueDate, new Date().toISOString().slice(0, 10))
        )
      );
    if (occurrences.length === 0) return;
    await transaction.delete(schema.paymentOccurrenceGroups).where(
      inArray(
        schema.paymentOccurrenceGroups.occurrenceId,
        occurrences.map((row) => row.id)
      )
    );
    await this.tagOccurrences(userId, occurrences, transaction);
  }

  /** Re-tag every bill with this payee — after a merge hands it new bills. */
  async retagPayee(userId: string, vendorId: string, transaction: DatabaseTransaction) {
    const bills = await transaction
      .select({ id: schema.payments.id })
      .from(schema.payments)
      .where(and(eq(schema.payments.userId, userId), eq(schema.payments.vendorId, vendorId)));
    await this.retagFuture(
      userId,
      bills.map((bill) => bill.id),
      transaction
    );
  }

  /** Give freshly written occurrences their bill's current groups. */
  async tagOccurrences(
    userId: string,
    occurrences: readonly { id: string; paymentId: string }[],
    transaction: DatabaseTransaction
  ): Promise<void> {
    if (occurrences.length === 0) return;
    const membership = await this.resolve(userId, transaction, [
      ...new Set(occurrences.map((row) => row.paymentId)),
    ]);
    const rows = occurrences.flatMap((row) =>
      [...(membership.get(row.paymentId)?.keys() ?? [])].map((groupId) => ({
        occurrenceId: row.id,
        groupId,
      }))
    );
    if (rows.length)
      await transaction.insert(schema.paymentOccurrenceGroups).values(rows).onConflictDoNothing();
  }
}

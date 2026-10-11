import { createHash, randomBytes } from 'node:crypto';
import { type DatabaseTransaction, getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { AccountRepository } from '../../repositories/AccountRepository';
import {
  HouseholdAccessService,
  type HouseholdMembership,
  type HouseholdRole,
} from './HouseholdAccessService';
import { HouseholdError } from './household-errors';

const INVITE_DAYS = 7;
const TOKEN_PREFIX = 'shh_';

export type InviteState = 'open' | 'expired' | 'revoked' | 'used';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function stateOf(
  invite: Pick<schema.HouseholdInvite, 'acceptedAt' | 'revokedAt' | 'expiresAt'>,
  now: Date
): InviteState {
  if (invite.acceptedAt) return 'used';
  if (invite.revokedAt) return 'revoked';
  if (invite.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'open';
}

const ownerName = sql<string>`coalesce(nullif(${schema.users.name}, ''), ${schema.users.email})`;

/**
 * Who belongs to a household, and how they join (SC-1647). Joining never
 * moves, merges or deletes anything: it writes one membership row.
 */
@Service()
export class HouseholdMembershipService {
  private readonly access = Container.get(HouseholdAccessService);
  private readonly accounts = Container.get(AccountRepository);

  private async within<T>(
    tx: DatabaseTransaction | undefined,
    work: (tx: DatabaseTransaction) => Promise<T>
  ): Promise<T> {
    return tx ? work(tx) : getDb().transaction(work);
  }

  private async requireAdmin(
    userId: string,
    tx: DatabaseTransaction | undefined
  ): Promise<HouseholdMembership> {
    const membership = await this.access.membershipOf(userId, tx);
    if (!membership) throw new HouseholdError('no-household', 'You are not in a household.');
    if (membership.role !== 'admin') {
      throw new HouseholdError('not-admin', 'Only the household admin can do that.');
    }
    return membership;
  }

  async create(userId: string, name: string, tx?: DatabaseTransaction): Promise<schema.Household> {
    return this.within(tx, async (db) => {
      if (await this.access.membershipOf(userId, db)) {
        throw new HouseholdError('already-member', 'You are already in a household.');
      }
      const [user] = await db
        .select({ baseCurrencyId: schema.users.baseCurrencyId })
        .from(schema.users)
        .where(eq(schema.users.id, userId));
      if (!user?.baseCurrencyId) {
        throw new Error(`HouseholdMembershipService: user ${userId} has no base currency`);
      }
      const [household] = await db
        .insert(schema.households)
        .values({ name: name.trim(), baseCurrencyId: user.baseCurrencyId, createdBy: userId })
        .returning();
      if (!household)
        throw new Error('HouseholdMembershipService: household insert returned nothing');
      await db
        .insert(schema.householdMembers)
        .values({ householdId: household.id, userId, role: 'admin' });
      return household;
    });
  }

  async invite(
    adminId: string,
    email: string,
    tx?: DatabaseTransaction
  ): Promise<{ inviteId: string; token: string; expiresAt: Date }> {
    return this.within(tx, async (db) => {
      const { householdId } = await this.requireAdmin(adminId, db);
      const invited = normaliseEmail(email);
      const [existing] = await db
        .select({ userId: schema.householdMembers.userId })
        .from(schema.householdMembers)
        .innerJoin(schema.users, eq(schema.users.id, schema.householdMembers.userId))
        .where(
          and(
            eq(schema.householdMembers.householdId, householdId),
            eq(sql`lower(${schema.users.email})`, invited)
          )
        )
        .limit(1);
      if (existing) throw new HouseholdError('already-member', `${invited} is already a member.`);

      const token = `${TOKEN_PREFIX}${randomBytes(24).toString('hex')}`;
      const expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000);
      const [row] = await db
        .insert(schema.householdInvites)
        .values({
          householdId,
          email: invited,
          tokenHash: hashToken(token),
          invitedBy: adminId,
          expiresAt,
        })
        .returning({ id: schema.householdInvites.id });
      if (!row) throw new Error('HouseholdMembershipService: invite insert returned nothing');
      return { inviteId: row.id, token, expiresAt };
    });
  }

  async previewInvite(
    token: string,
    tx?: DatabaseTransaction
  ): Promise<{ householdName: string; inviterName: string; state: InviteState }> {
    const db = tx ?? getDb();
    const [row] = await db
      .select({
        householdName: schema.households.name,
        inviterName: ownerName,
        acceptedAt: schema.householdInvites.acceptedAt,
        revokedAt: schema.householdInvites.revokedAt,
        expiresAt: schema.householdInvites.expiresAt,
      })
      .from(schema.householdInvites)
      .innerJoin(schema.households, eq(schema.households.id, schema.householdInvites.householdId))
      .innerJoin(schema.users, eq(schema.users.id, schema.householdInvites.invitedBy))
      .where(eq(schema.householdInvites.tokenHash, hashToken(token)));
    if (!row) throw new HouseholdError('invite-invalid', 'This invite link is not valid.');
    return {
      householdName: row.householdName,
      inviterName: row.inviterName,
      state: stateOf(row, new Date()),
    };
  }

  async accept(
    userId: string,
    userEmail: string,
    token: string,
    tx?: DatabaseTransaction
  ): Promise<HouseholdMembership> {
    return this.within(tx, async (db) => {
      const [invite] = await db
        .select()
        .from(schema.householdInvites)
        .where(eq(schema.householdInvites.tokenHash, hashToken(token)))
        .for('update');
      if (!invite) throw new HouseholdError('invite-invalid', 'This invite link is not valid.');
      const state = stateOf(invite, new Date());
      if (state === 'used')
        throw new HouseholdError('invite-used', 'This invite was already used.');
      if (state === 'revoked')
        throw new HouseholdError('invite-revoked', 'This invite was revoked.');
      if (state === 'expired')
        throw new HouseholdError('invite-expired', 'This invite has expired.');
      if (normaliseEmail(userEmail) !== invite.email) {
        throw new HouseholdError(
          'invite-email-mismatch',
          `This invite is for ${invite.email}. Sign in with that email to accept it.`
        );
      }
      if (await this.access.membershipOf(userId, db)) {
        throw new HouseholdError('already-member', 'Leave your household first.');
      }
      await db
        .insert(schema.householdMembers)
        .values({ householdId: invite.householdId, userId, role: 'member' });
      await db
        .update(schema.householdInvites)
        .set({ acceptedAt: new Date() })
        .where(eq(schema.householdInvites.id, invite.id));
      const membership = await this.access.membershipOf(userId, db);
      if (!membership)
        throw new Error('HouseholdMembershipService: membership missing after accept');
      return membership;
    });
  }

  async revoke(adminId: string, inviteId: string, tx?: DatabaseTransaction): Promise<void> {
    await this.within(tx, async (db) => {
      const { householdId } = await this.requireAdmin(adminId, db);
      await db
        .update(schema.householdInvites)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(schema.householdInvites.id, inviteId),
            eq(schema.householdInvites.householdId, householdId),
            isNull(schema.householdInvites.acceptedAt)
          )
        );
    });
  }

  private async requireMember(
    userId: string,
    tx: DatabaseTransaction
  ): Promise<HouseholdMembership> {
    const membership = await this.access.membershipOf(userId, tx);
    if (!membership) throw new HouseholdError('no-household', 'You are not in a household.');
    return membership;
  }

  private async requireOwnAccount(ownerId: string, accountId: string, tx: DatabaseTransaction) {
    if (!(await this.accounts.findByIdAndUser(accountId, ownerId, tx))) {
      throw new HouseholdError('not-owner', 'Only the account’s owner can share it.');
    }
  }

  /** Shares one of the owner's accounts with their household. Idempotent. */
  async share(ownerId: string, accountId: string, tx?: DatabaseTransaction): Promise<void> {
    await this.within(tx, async (db) => {
      await this.requireOwnAccount(ownerId, accountId, db);
      const { householdId } = await this.requireMember(ownerId, db);
      await db
        .insert(schema.accountShares)
        .values({ accountId, householdId, sharedBy: ownerId })
        .onConflictDoNothing();
    });
  }

  async unshare(ownerId: string, accountId: string, tx?: DatabaseTransaction): Promise<void> {
    await this.within(tx, async (db) => {
      await this.requireOwnAccount(ownerId, accountId, db);
      await db
        .delete(schema.accountShares)
        .where(
          and(
            eq(schema.accountShares.accountId, accountId),
            eq(schema.accountShares.sharedBy, ownerId)
          )
        );
    });
  }

  /** Ends one person's membership: their shares go first, then the row. */
  private async endMembership(householdId: string, userId: string, tx: DatabaseTransaction) {
    await tx
      .delete(schema.accountShares)
      .where(
        and(
          eq(schema.accountShares.householdId, householdId),
          eq(schema.accountShares.sharedBy, userId)
        )
      );
    await tx
      .delete(schema.householdMembers)
      .where(
        and(
          eq(schema.householdMembers.householdId, householdId),
          eq(schema.householdMembers.userId, userId)
        )
      );
  }

  private async otherMembers(householdId: string, userId: string, tx: DatabaseTransaction) {
    return tx
      .select({ userId: schema.householdMembers.userId })
      .from(schema.householdMembers)
      .where(
        and(
          eq(schema.householdMembers.householdId, householdId),
          sql`${schema.householdMembers.userId} <> ${userId}`
        )
      )
      .orderBy(asc(schema.householdMembers.joinedAt), asc(schema.householdMembers.userId));
  }

  async leave(userId: string, tx?: DatabaseTransaction): Promise<void> {
    await this.within(tx, async (db) => {
      const { householdId, role } = await this.requireMember(userId, db);
      if (role === 'admin') {
        if ((await this.otherMembers(householdId, userId, db)).length > 0) {
          throw new HouseholdError(
            'admin-must-hand-over',
            'Hand the admin role to another member, or remove everyone, before you leave.'
          );
        }
        await db.delete(schema.households).where(eq(schema.households.id, householdId));
        return;
      }
      await this.endMembership(householdId, userId, db);
    });
  }

  async remove(adminId: string, memberId: string, tx?: DatabaseTransaction): Promise<void> {
    await this.within(tx, async (db) => {
      const { householdId } = await this.requireAdmin(adminId, db);
      const member = await this.access.membershipOf(memberId, db);
      if (!member || member.householdId !== householdId || memberId === adminId) {
        throw new HouseholdError('not-a-member', 'That person is not a member of your household.');
      }
      await this.endMembership(householdId, memberId, db);
    });
  }

  async transferAdmin(adminId: string, memberId: string, tx?: DatabaseTransaction): Promise<void> {
    await this.within(tx, async (db) => {
      const { householdId } = await this.requireAdmin(adminId, db);
      const member = await this.access.membershipOf(memberId, db);
      if (!member || member.householdId !== householdId || memberId === adminId) {
        throw new HouseholdError('not-a-member', 'That person is not a member of your household.');
      }
      await this.setRole(householdId, memberId, 'admin', db);
      await this.setRole(householdId, adminId, 'member', db);
    });
  }

  private async setRole(
    householdId: string,
    userId: string,
    role: 'admin' | 'member',
    tx: DatabaseTransaction
  ) {
    await tx
      .update(schema.householdMembers)
      .set({ role })
      .where(
        and(
          eq(schema.householdMembers.householdId, householdId),
          eq(schema.householdMembers.userId, userId)
        )
      );
  }

  async setCurrency(adminId: string, tokenId: string, tx?: DatabaseTransaction): Promise<void> {
    await this.within(tx, async (db) => {
      const { householdId } = await this.requireAdmin(adminId, db);
      await db
        .update(schema.households)
        .set({ baseCurrencyId: tokenId })
        .where(eq(schema.households.id, householdId));
    });
  }

  /**
   * Runs before a user's rows are deleted. An admin with other members hands
   * the role to the member who joined first; an admin alone takes the
   * household with them. A plain member needs nothing here: the manifest
   * deletes their membership and their accounts' shares.
   */
  async beforeUserRemoved(userId: string, tx: DatabaseTransaction): Promise<void> {
    const membership = await this.access.membershipOf(userId, tx);
    if (!membership || membership.role !== 'admin') return;
    const [next] = await this.otherMembers(membership.householdId, userId, tx);
    if (!next) {
      await tx.delete(schema.households).where(eq(schema.households.id, membership.householdId));
      return;
    }
    await this.setRole(membership.householdId, next.userId, 'admin', tx);
  }

  /** The viewer's household, admin first then by join date; empty without one. */
  async members(
    userId: string,
    tx?: DatabaseTransaction
  ): Promise<Array<{ userId: string; name: string; role: HouseholdRole; joinedAt: Date }>> {
    const membership = await this.access.membershipOf(userId, tx);
    if (!membership) return [];
    const rows = await (tx ?? getDb())
      .select({
        userId: schema.householdMembers.userId,
        name: sql<string>`coalesce(nullif(${schema.users.name}, ''), ${schema.users.email})`,
        role: schema.householdMembers.role,
        joinedAt: schema.householdMembers.joinedAt,
      })
      .from(schema.householdMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.householdMembers.userId))
      .where(eq(schema.householdMembers.householdId, membership.householdId))
      .orderBy(
        sql`${schema.householdMembers.role} = 'admin' desc`,
        asc(schema.householdMembers.joinedAt)
      );
    return rows.map((r) => ({ ...r, role: r.role as HouseholdRole }));
  }

  async pendingInvites(
    adminId: string,
    tx?: DatabaseTransaction
  ): Promise<Array<{ id: string; email: string; expiresAt: Date }>> {
    const { householdId } = await this.requireAdmin(adminId, tx);
    return (tx ?? getDb())
      .select({
        id: schema.householdInvites.id,
        email: schema.householdInvites.email,
        expiresAt: schema.householdInvites.expiresAt,
      })
      .from(schema.householdInvites)
      .where(
        and(
          eq(schema.householdInvites.householdId, householdId),
          isNull(schema.householdInvites.acceptedAt),
          isNull(schema.householdInvites.revokedAt),
          gt(schema.householdInvites.expiresAt, new Date())
        )
      )
      .orderBy(asc(schema.householdInvites.createdAt));
  }
}

import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { HouseholdAccessService } from '../../../src/services/household/HouseholdAccessService';
import { HouseholdMembershipService } from '../../../src/services/household/HouseholdMembershipService';
import { HouseholdError } from '../../../src/services/household/household-errors';
import { withTestDb } from '../../../test/helpers/db';
import { makeUser } from '../../../test/helpers/factories';
import { makeToken } from '../../../test/helpers/factories-extra';

const memberships = new HouseholdMembershipService();
const access = new HouseholdAccessService();
const DAY = 86_400_000;

async function person(tx: DatabaseTransaction, email: string) {
  const usd = await makeToken(tx);
  return makeUser(tx, { email, name: email.split('@')[0] ?? email, baseCurrencyId: usd.id });
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (err) {
    if (err instanceof HouseholdError) return err.code;
    throw err;
  }
  return 'no error';
}

describe('HouseholdMembershipService: households and invites (SC-1647)', () => {
  test('create makes the creator its admin, in the creator’s base currency', async () => {
    await withTestDb(async (tx) => {
      const alice = await person(tx, 'alice@example.com');
      const household = await memberships.create(alice.id, 'Home', tx);

      expect(household.baseCurrencyId).toBe(alice.baseCurrencyId ?? '');
      expect((await access.membershipOf(alice.id, tx))?.role).toBe('admin');
      expect(await codeOf(memberships.create(alice.id, 'Second', tx))).toBe('already-member');
    });
  });

  test('an invite stores only the token’s sha256 and expires in 7 days', async () => {
    await withTestDb(async (tx) => {
      const alice = await person(tx, 'alice@example.com');
      await memberships.create(alice.id, 'Home', tx);
      const before = Date.now();
      const invite = await memberships.invite(alice.id, 'bob@example.com', tx);

      const [row] = await tx
        .select()
        .from(schema.householdInvites)
        .where(eq(schema.householdInvites.id, invite.inviteId));
      expect(row?.tokenHash).toHaveLength(64);
      expect(row?.tokenHash).not.toContain(invite.token);
      expect(invite.expiresAt.getTime() - before).toBeGreaterThanOrEqual(7 * DAY - 1000);
      expect(invite.expiresAt.getTime() - before).toBeLessThanOrEqual(7 * DAY + 1000);
    });
  });

  test('only the admin invites', async () => {
    await withTestDb(async (tx) => {
      const alice = await person(tx, 'alice@example.com');
      const bob = await person(tx, 'bob@example.com');
      await memberships.create(alice.id, 'Home', tx);
      const invite = await memberships.invite(alice.id, 'bob@example.com', tx);
      await memberships.accept(bob.id, 'bob@example.com', invite.token, tx);

      expect(await codeOf(memberships.invite(bob.id, 'carol@example.com', tx))).toBe('not-admin');
    });
  });

  test('accepting with the invited email adds a member', async () => {
    await withTestDb(async (tx) => {
      const alice = await person(tx, 'alice@example.com');
      const bob = await person(tx, 'bob@example.com');
      const household = await memberships.create(alice.id, 'Home', tx);
      const invite = await memberships.invite(alice.id, 'Bob@Example.com', tx);

      const joined = await memberships.accept(bob.id, 'bob@example.com', invite.token, tx);
      expect(joined).toEqual({
        householdId: household.id,
        name: 'Home',
        role: 'member',
        baseCurrencyId: household.baseCurrencyId,
      });
    });
  });

  test('members lists the household in join order, admin first, by name', async () => {
    await withTestDb(async (tx) => {
      const alice = await person(tx, 'alice@example.com');
      const bob = await person(tx, 'bob@example.com');
      const outsider = await person(tx, 'carol@example.com');
      await memberships.create(alice.id, 'Home', tx);
      const invite = await memberships.invite(alice.id, 'bob@example.com', tx);
      await memberships.accept(bob.id, 'bob@example.com', invite.token, tx);

      const members = await memberships.members(bob.id, tx);
      expect(members.map((m) => [m.userId, m.name, m.role])).toEqual([
        [alice.id, 'alice', 'admin'],
        [bob.id, 'bob', 'member'],
      ]);
      expect(await memberships.members(outsider.id, tx)).toEqual([]);
    });
  });

  test('a forwarded link: another signed-in email is refused and joins nothing', async () => {
    await withTestDb(async (tx) => {
      const alice = await person(tx, 'alice@example.com');
      const mallory = await person(tx, 'mallory@example.com');
      await memberships.create(alice.id, 'Home', tx);
      const invite = await memberships.invite(alice.id, 'bob@example.com', tx);

      expect(
        await codeOf(memberships.accept(mallory.id, 'mallory@example.com', invite.token, tx))
      ).toBe('invite-email-mismatch');
      expect(await access.membershipOf(mallory.id, tx)).toBeNull();
    });
  });

  test('accepting while in another household is refused and leaves the invite open', async () => {
    await withTestDb(async (tx) => {
      const alice = await person(tx, 'alice@example.com');
      const bob = await person(tx, 'bob@example.com');
      await memberships.create(alice.id, 'Home', tx);
      await memberships.create(bob.id, 'Bob’s', tx);
      const invite = await memberships.invite(alice.id, 'bob@example.com', tx);

      expect(await codeOf(memberships.accept(bob.id, 'bob@example.com', invite.token, tx))).toBe(
        'already-member'
      );
      expect((await memberships.previewInvite(invite.token, tx)).state).toBe('open');
    });
  });

  test('an expired, a revoked and a used invite are each refused, and the preview says which', async () => {
    await withTestDb(async (tx) => {
      const alice = await person(tx, 'alice@example.com');
      const bob = await person(tx, 'bob@example.com');
      const carol = await person(tx, 'carol@example.com');
      await memberships.create(alice.id, 'Home', tx);

      const expired = await memberships.invite(alice.id, 'carol@example.com', tx);
      await tx
        .update(schema.householdInvites)
        .set({ expiresAt: new Date(Date.now() - 1) })
        .where(eq(schema.householdInvites.id, expired.inviteId));
      expect(
        await codeOf(memberships.accept(carol.id, 'carol@example.com', expired.token, tx))
      ).toBe('invite-expired');
      expect((await memberships.previewInvite(expired.token, tx)).state).toBe('expired');

      const revoked = await memberships.invite(alice.id, 'carol@example.com', tx);
      await memberships.revoke(alice.id, revoked.inviteId, tx);
      expect(
        await codeOf(memberships.accept(carol.id, 'carol@example.com', revoked.token, tx))
      ).toBe('invite-revoked');
      expect((await memberships.previewInvite(revoked.token, tx)).state).toBe('revoked');

      const used = await memberships.invite(alice.id, 'bob@example.com', tx);
      await memberships.accept(bob.id, 'bob@example.com', used.token, tx);
      expect(await codeOf(memberships.accept(bob.id, 'bob@example.com', used.token, tx))).toBe(
        'invite-used'
      );
      expect((await memberships.previewInvite(used.token, tx)).state).toBe('used');
      expect(await access.membershipOf(carol.id, tx)).toBeNull();
    });
  });

  test('an unknown token is invalid, and the preview names the household and inviter', async () => {
    await withTestDb(async (tx) => {
      const alice = await person(tx, 'alice@example.com');
      await memberships.create(alice.id, 'Home', tx);
      const invite = await memberships.invite(alice.id, 'bob@example.com', tx);

      expect(await codeOf(memberships.previewInvite('shh_nope', tx))).toBe('invite-invalid');
      expect(await memberships.previewInvite(invite.token, tx)).toEqual({
        householdName: 'Home',
        inviterName: 'alice',
        state: 'open',
      });
      expect(await memberships.pendingInvites(alice.id, tx)).toEqual([
        { id: invite.inviteId, email: 'bob@example.com', expiresAt: invite.expiresAt },
      ]);
    });
  });
});

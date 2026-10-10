import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { EmailFacade } from '@scani/cloud-client/facades/email-facade';
import { getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import {
  makeAccount,
  makeInstitution,
  makeInstitutionType,
  makeToken,
  makeUser,
  restoreContainerAfterAll,
} from '@scani/domain/test-helpers';
import { TRPCError } from '@trpc/server';
import { inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { makeAuthedCaller } from '../../helpers/test-caller';

// `household` (SC-1647). The services read through the global connection, so
// this commits its own rows and removes them.

restoreContainerAfterAll();

const db = () => getDb();
const made = {
  users: [] as string[],
  tokens: [] as string[],
  institutions: [] as string[],
  households: [] as string[],
};
const sent: Array<{ to: string; content: { text: string } }> = [];
let usdId = '';
let institutionId = '';

function mail(canSend: boolean): void {
  Container.set(EmailFacade, {
    canSendCustomMail: () => canSend,
    sendBranded: async (input: (typeof sent)[number]) => {
      sent.push(input);
    },
  } as unknown as EmailFacade);
}

async function person(name: string) {
  const user = await db().transaction((tx) =>
    makeUser(tx, {
      email: `${name}-${crypto.randomUUID().slice(0, 8)}@scani.local`,
      name,
      baseCurrencyId: usdId,
    })
  );
  made.users.push(user.id);
  return user;
}

async function accountOf(userId: string) {
  return db().transaction((tx) => makeAccount(tx, { userId, institutionId, name: 'Joint' }));
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (err) {
    if (err instanceof TRPCError) return err.code;
    throw err;
  }
  return 'no error';
}

/** Alice's household with Bob joined through a real invite. */
async function household() {
  const alice = await person('alice');
  const bob = await person('bob');
  const asAlice = makeAuthedCaller(alice);
  const asBob = makeAuthedCaller(bob);
  const created = await asAlice.household.create({ name: 'Home' });
  made.households.push(created.id);
  const { url } = await asAlice.household.invite({ email: bob.email });
  const token = new URL(url).searchParams.get('returnTo')?.split('token=')[1] ?? '';
  await asBob.household.accept({ token });
  return { alice, bob, asAlice, asBob, token };
}

beforeAll(async () => {
  const usd = await db().transaction((tx) => makeToken(tx));
  made.tokens.push(usd.id);
  usdId = usd.id;
  const type = await db().transaction((tx) => makeInstitutionType(tx, { code: 'bank' }));
  const institution = await db().transaction((tx) => makeInstitution(tx, { typeId: type.id }));
  made.institutions.push(institution.id);
  institutionId = institution.id;
});

beforeEach(() => {
  sent.length = 0;
  mail(false);
});

afterAll(async () => {
  if (made.households.length) {
    await db().delete(schema.households).where(inArray(schema.households.id, made.households));
  }
  await db().delete(schema.users).where(inArray(schema.users.id, made.users));
  await db().delete(schema.institutions).where(inArray(schema.institutions.id, made.institutions));
  await db().delete(schema.tokens).where(inArray(schema.tokens.id, made.tokens));
});

describe('household router (SC-1647)', () => {
  test('mine is empty before a household, and names the creator as admin after', async () => {
    const alice = await person('alice');
    const asAlice = makeAuthedCaller(alice);
    expect(await asAlice.household.mine()).toEqual({
      household: null,
      members: [],
      invites: [],
      sharedAccountIds: [],
    });

    const created = await asAlice.household.create({ name: 'Home' });
    made.households.push(created.id);
    const mine = await asAlice.household.mine();

    expect(mine.household).toMatchObject({ householdId: created.id, name: 'Home', role: 'admin' });
    expect(mine.household?.baseCurrencyId).toBe(usdId);
    expect(mine.members.map((m) => [m.userId, m.role])).toEqual([[alice.id, 'admin']]);
    expect(mine.invites).toEqual([]);
    expect(mine.sharedAccountIds).toEqual([]);
  });

  test('invite returns a sign-in link that returns to the accept page, and says it was not emailed', async () => {
    const alice = await person('alice');
    const asAlice = makeAuthedCaller(alice);
    const created = await asAlice.household.create({ name: 'Home' });
    made.households.push(created.id);

    const invite = await asAlice.household.invite({ email: 'bob@example.com' });

    const url = new URL(invite.url);
    expect(url.pathname).toBe('/auth');
    expect(url.searchParams.get('returnTo')).toMatch(
      /^\/household\/accept\?token=shh_[0-9a-f]{48}$/
    );
    expect(invite.emailed).toBe(false);
    expect(sent).toEqual([]);
    expect((await asAlice.household.mine()).invites.map((i) => i.email)).toEqual([
      'bob@example.com',
    ]);
  });

  test('when this instance can send mail, the invite goes out untracked with the same link', async () => {
    mail(true);
    const alice = await person('alice');
    const asAlice = makeAuthedCaller(alice);
    const created = await asAlice.household.create({ name: 'Home' });
    made.households.push(created.id);

    const invite = await asAlice.household.invite({ email: 'bob@example.com' });

    expect(invite.emailed).toBe(true);
    expect(sent.map((m) => m.to)).toEqual(['bob@example.com']);
    expect(sent[0]?.content.text).toContain(invite.url);
  });

  test('preview names the household, accept joins, and a member sees both members and no invites', async () => {
    const alice = await person('alice');
    const bob = await person('bob');
    const asAlice = makeAuthedCaller(alice);
    const asBob = makeAuthedCaller(bob);
    const created = await asAlice.household.create({ name: 'Home' });
    made.households.push(created.id);
    const { url } = await asAlice.household.invite({ email: bob.email });
    const token = new URL(url).searchParams.get('returnTo')?.split('token=')[1] ?? '';

    expect(await asBob.household.previewInvite({ token })).toEqual({
      householdName: 'Home',
      inviterName: 'alice',
      state: 'open',
    });
    await asBob.household.accept({ token });

    const mine = await asBob.household.mine();
    expect(mine.household?.role).toBe('member');
    expect(mine.members.map((m) => m.name)).toEqual(['alice', 'bob']);
    expect(mine.invites).toEqual([]);
    expect(await codeOf(asBob.household.accept({ token }))).toBe('CONFLICT');
  });

  test('only the owner shares an account; a member naming another member’s account is NOT_FOUND', async () => {
    const { alice, asAlice, asBob } = await household();
    const account = await accountOf(alice.id);

    expect(await codeOf(asBob.household.share({ accountId: account.id }))).toBe('NOT_FOUND');
    await asAlice.household.share({ accountId: account.id });
    expect((await asAlice.household.mine()).sharedAccountIds).toEqual([account.id]);
    expect((await asBob.household.mine()).sharedAccountIds).toEqual([]);

    await asAlice.household.unshare({ accountId: account.id });
    expect((await asAlice.household.mine()).sharedAccountIds).toEqual([]);
  });

  test('admin-only acts are FORBIDDEN to a member, and the admin cannot leave while others remain', async () => {
    const { bob, asAlice, asBob } = await household();

    expect(await codeOf(asBob.household.invite({ email: 'carol@example.com' }))).toBe('FORBIDDEN');
    expect(await codeOf(asBob.household.remove({ userId: bob.id }))).toBe('FORBIDDEN');
    expect(await codeOf(asBob.household.setCurrency({ tokenId: usdId }))).toBe('FORBIDDEN');
    expect(await codeOf(asAlice.household.leave())).toBe('CONFLICT');
  });

  test('a forwarded link is FORBIDDEN to another email, and an unknown token is NOT_FOUND', async () => {
    const alice = await person('alice');
    const carol = await person('carol');
    const asAlice = makeAuthedCaller(alice);
    const created = await asAlice.household.create({ name: 'Home' });
    made.households.push(created.id);
    const { url } = await asAlice.household.invite({ email: 'bob@example.com' });
    const token = new URL(url).searchParams.get('returnTo')?.split('token=')[1] ?? '';

    expect(await codeOf(makeAuthedCaller(carol).household.accept({ token }))).toBe('FORBIDDEN');
    expect(await codeOf(makeAuthedCaller(carol).household.accept({ token: 'shh_nope' }))).toBe(
      'NOT_FOUND'
    );
  });

  test('revoke closes an invite, and a revoked invite is CONFLICT to accept', async () => {
    const alice = await person('alice');
    const bob = await person('bob');
    const asAlice = makeAuthedCaller(alice);
    const created = await asAlice.household.create({ name: 'Home' });
    made.households.push(created.id);
    const { url } = await asAlice.household.invite({ email: bob.email });
    const token = new URL(url).searchParams.get('returnTo')?.split('token=')[1] ?? '';
    const [pending] = (await asAlice.household.mine()).invites;

    await asAlice.household.revoke({ inviteId: pending?.id ?? '' });

    expect((await asAlice.household.mine()).invites).toEqual([]);
    expect(await codeOf(makeAuthedCaller(bob).household.accept({ token }))).toBe('CONFLICT');
  });

  test('transferAdmin hands the role over, and the old admin may then leave', async () => {
    const { bob, asAlice, asBob } = await household();

    await asAlice.household.transferAdmin({ userId: bob.id });
    expect((await asBob.household.mine()).household?.role).toBe('admin');
    await asAlice.household.leave();
    expect((await asAlice.household.mine()).household).toBeNull();
  });

  test('view and history are NOT_FOUND outside a household, and an un-shared account leaves the very next view', async () => {
    const { alice, bob, asAlice, asBob } = await household();
    const asCarol = makeAuthedCaller(await person('carol'));
    const range = { from: new Date('2026-09-01'), to: new Date('2026-09-30') };
    expect(await codeOf(asCarol.household.view({ dimension: 'token_type' }))).toBe('NOT_FOUND');
    expect(await codeOf(asCarol.household.history(range))).toBe('NOT_FOUND');

    const aliceAccount = await accountOf(alice.id);
    const bobAccount = await accountOf(bob.id);
    await asAlice.household.share({ accountId: aliceAccount.id });
    await asBob.household.share({ accountId: bobAccount.id });
    const before = await asAlice.household.view({ dimension: 'token_type' });
    expect(before.accounts.map((row) => row.accountId).sort()).toEqual(
      [aliceAccount.id, bobAccount.id].sort()
    );
    // Both accounts are "Joint" at one institution: named, not dropped.
    expect(before.trackedTwice.map((pair) => pair.reason)).toEqual(['same-name']);

    await asBob.household.unshare({ accountId: bobAccount.id });
    const after = await asAlice.household.view({ dimension: 'token_type' });
    expect(after.accounts.map((row) => row.accountId)).toEqual([aliceAccount.id]);
    expect(after.trackedTwice).toEqual([]);
    expect(await asAlice.household.history(range)).toEqual({
      baseCurrencyId: usdId,
      series: [],
      unmeasuredDates: [],
    });
  });

  test('a member who leaves, or is removed, gets no household on their very next read', async () => {
    const first = await household();
    await first.asBob.household.leave();
    expect(await first.asBob.household.mine()).toEqual({
      household: null,
      members: [],
      invites: [],
      sharedAccountIds: [],
    });

    const second = await household();
    await second.asAlice.household.remove({ userId: second.bob.id });
    expect((await second.asBob.household.mine()).household).toBeNull();
    expect((await second.asAlice.household.mine()).members.map((m) => m.userId)).toEqual([
      second.alice.id,
    ]);
  });
});

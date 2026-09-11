import { afterAll, describe, expect, test } from 'bun:test';
import { db } from '@scani/db';
import { users } from '@scani/db/schema';
import { eq, inArray } from 'drizzle-orm';
import {
  DEMO_SIGNUP_TAG,
  recordSignupSource,
  SIGNUP_SOURCE_PARAM,
  signupSourceFromAuthContext,
} from '../../src/auth/signup-source';

/**
 * SC-515. Both arms matter and the second one is the point: a column that only
 * ever records `demo` cannot tell anybody that a signup did NOT come from the
 * demo, so `direct` — an observed absence — is what makes the funnel readable.
 * `unknown` is a third thing again: the flow could not have carried a tag.
 *
 * Everything goes through `signupSourceFromAuthContext` rather than the pure
 * parser beneath it, because the context shape is the half that can go silently
 * wrong: a Better-Auth rename would make every signup read `unknown` and
 * nothing else in the tree would notice.
 */

/** The shape Better-Auth hands `user.create.after` on `/magic-link/verify`. */
const verifyContext = (callbackURL: unknown) => ({ query: { token: 'tok', callbackURL } });

describe('signupSourceFromAuthContext', () => {
  test('a callbackURL carrying the demo tag reads demo', () => {
    expect(
      signupSourceFromAuthContext(verifyContext('https://app.scani.xyz/auth/callback?src=demo'))
    ).toBe('demo');
  });

  test('the CONTROL — an ordinary signup reads direct, not demo and not nothing', () => {
    expect(signupSourceFromAuthContext(verifyContext('https://app.scani.xyz/auth/callback'))).toBe(
      'direct'
    );
  });

  test("Better-Auth's own default callbackURL is still an observed absence", () => {
    // `signInMagicLink` substitutes `"/"` when a caller sends none, so this is
    // what a hand-rolled magic-link request produces. The flow could have
    // carried a tag; it did not.
    expect(signupSourceFromAuthContext(verifyContext('/'))).toBe('direct');
  });

  test('a relative callbackURL is read the same as an absolute one', () => {
    expect(signupSourceFromAuthContext(verifyContext('/auth/callback?src=demo'))).toBe('demo');
  });

  test('another tag is not the demo tag', () => {
    expect(signupSourceFromAuthContext(verifyContext('/auth/callback?src=newsletter'))).toBe(
      'direct'
    );
  });

  test('the match is exact — a lookalike is not the demo', () => {
    expect(signupSourceFromAuthContext(verifyContext('/auth/callback?src=demo-x'))).toBe('direct');
    expect(signupSourceFromAuthContext(verifyContext('/auth/callback?src=DEMO'))).toBe('direct');
  });

  test('a context with no query at all reads unknown, which is NOT direct', () => {
    // `POST /sign-in/email-otp` has a body and no query. Reading it as `direct`
    // would report an absence nobody observed.
    expect(signupSourceFromAuthContext({})).toBe('unknown');
    expect(signupSourceFromAuthContext(undefined)).toBe('unknown');
  });

  test('a query with no callbackURL, or a non-string one, is unknown rather than a crash', () => {
    expect(signupSourceFromAuthContext({ query: { token: 'tok' } })).toBe('unknown');
    expect(signupSourceFromAuthContext(verifyContext(''))).toBe('unknown');
    expect(signupSourceFromAuthContext(verifyContext('   '))).toBe('unknown');
    expect(signupSourceFromAuthContext(verifyContext(42))).toBe('unknown');
    expect(signupSourceFromAuthContext(verifyContext(null))).toBe('unknown');
    expect(signupSourceFromAuthContext(verifyContext({ src: 'demo' }))).toBe('unknown');
  });

  test('the tag the demo emits and the tag this reads are the same string', () => {
    // The two constants are the wire contract between `config/demo.ts` and this
    // file. Building the URL from them rather than typing `?src=demo` again is
    // what makes a rename of either one show up here.
    expect(
      signupSourceFromAuthContext(
        verifyContext(`/auth/callback?${SIGNUP_SOURCE_PARAM}=${DEMO_SIGNUP_TAG}`)
      )
    ).toBe('demo');
  });
});

/**
 * The write itself. `signupSourceFromAuthContext` returning the right word is
 * worth nothing if the column stays NULL — which is precisely how this would
 * fail if the value were handed to a Better-Auth `create.before` hook instead
 * (its adapter drops any column not in its own schema map, silently).
 */
describe('recordSignupSource', () => {
  const created: string[] = [];

  afterAll(async () => {
    if (created.length > 0) await db.delete(users).where(inArray(users.id, created));
  });

  async function makeUser(): Promise<string> {
    const [row] = await db
      .insert(users)
      .values({ email: `sc515-${crypto.randomUUID()}@scani.test`, name: 'SC-515 probe' })
      .returning({ id: users.id });
    if (!row) throw new Error('could not create the probe user');
    created.push(row.id);
    return row.id;
  }

  async function sourceOf(id: string): Promise<string | null> {
    const [row] = await db
      .select({ signupSource: users.signupSource })
      .from(users)
      .where(eq(users.id, id));
    return row?.signupSource ?? null;
  }

  test('a fresh account starts NULL — "predates the column", not "not from the demo"', async () => {
    // The control for both writes below: without it, a column that was already
    // 'demo' would make the first assertion pass for the wrong reason.
    expect(await sourceOf(await makeUser())).toBeNull();
  });

  test('writes demo for a tagged sign-in', async () => {
    const id = await makeUser();
    await recordSignupSource(id, signupSourceFromAuthContext(verifyContext('/cb?src=demo')));
    expect(await sourceOf(id)).toBe('demo');
  });

  test('the CONTROL — writes direct for an ordinary one, so the column can discriminate', async () => {
    const id = await makeUser();
    await recordSignupSource(id, signupSourceFromAuthContext(verifyContext('/cb')));
    expect(await sourceOf(id)).toBe('direct');
  });

  test('never throws — an account that exists beats knowing where it came from', async () => {
    // A user id that is not in the table. The UPDATE matches nothing and the
    // caller is a hook finishing a stranger's first sign-in.
    await expect(recordSignupSource(crypto.randomUUID(), 'demo')).resolves.toBeUndefined();
  });
});

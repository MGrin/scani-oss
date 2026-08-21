/**
 * The three things that make demo mode safe, in one place (SC-466).
 *
 * Demo mode lets a stranger with no credential read one fictional portfolio.
 * The obvious way to build that — a boolean the API reads — is a
 * data-exposure bug wearing a feature toggle: set it on `app.scani.xyz` by
 * accident and every request arrives authenticated. So the flag alone is
 * never what protects anything. Three independent layers do, and each of them
 * would have to fail before a real user's row could be read:
 *
 * 1. **The flag.** `SCANI_DEMO_MODE` must be exactly `1`. Absent, empty,
 *    `true`, `yes` and `0` all mean off — see `isDemoModeRequested`.
 * 2. **The database.** At boot the process reads every email in `users` and
 *    refuses to start if any of them is not the demo persona
 *    (`assertDemoOnlyUsers`). Production holds real accounts, so the flag set
 *    there does not open a demo — it takes the process down, loudly, before
 *    it serves a request. This is the layer that makes the flag *impossible*
 *    to set in production rather than merely inadvisable.
 * 3. **The identity.** The synthesized session is only ever
 *    `DEMO_USER_EMAIL`. There is no input, header or cookie that selects a
 *    different one, so even a process that somehow got past layers 1 and 2
 *    resolves to a user that does not exist in production, and every
 *    user-scoped read returns nothing.
 *
 * Layer 2 is the one worth arguing with, because a refuse-everything guard is
 * indistinguishable from a working one until you watch it accept something
 * (SC-478 / SC-482). Its tests therefore pair every refusal with the
 * legitimate case — a database holding the demo persona and nobody else —
 * and assert that one passes.
 */

import { DEMO_MODE_ENV_VAR, isDemoModeRequested } from '@scani/config';
import type { DatabaseTransaction } from '@scani/db';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { demoUuid } from './deterministic';
import { DEMO_USER_EMAIL, DEMO_USER_NAME } from './persona';

// Layer 1 itself lives in `@scani/config`, and is re-exported here so this
// file still reads as the one place the three layers are described.
// `@scani/cloud-client` needs the same predicate — a demo has no
// data-provider, so `SCANI_CLOUD_URL` is legitimately unset there while
// production requires it — and `@scani/domain` depends on
// `@scani/cloud-client`, so the import can only go one way. A second copy of
// `=== '1'` was the alternative, and the exactness is the security property.
export { DEMO_MODE_ENV_VAR, isDemoModeRequested };

/** The persona's identity, derived rather than read — see `assertDemoOnlyUsers`. */
export interface DemoIdentity {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

/**
 * Who a demo visitor is, computed from constants and never from the database.
 *
 * The id is the same value `buildDemoDataset` writes, because both call
 * `demoUuid('user', DEMO_USER_EMAIL)` — so it is correct across a reseed, and
 * correct in the seconds during a reseed when the row does not exist at all.
 * That is what stops a scheduled reset from bouncing whoever is looking at the
 * demo to the sign-in screen: there is no session to lose and no row to miss.
 */
export function demoIdentity(): DemoIdentity {
  return { id: demoUuid('user', DEMO_USER_EMAIL), email: DEMO_USER_EMAIL, name: DEMO_USER_NAME };
}

/** Every email in `emails` that is not the demo persona, lower-cased for comparison. */
export function foreignUserEmails(emails: readonly (string | null)[]): string[] {
  const demo = DEMO_USER_EMAIL.toLowerCase();
  return emails
    .map((email) => (email ?? '').trim().toLowerCase())
    .filter((email) => email.length > 0 && email !== demo);
}

export class DemoModeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DemoModeRefused';
  }
}

/**
 * Throws unless the emails belong to a database that holds the demo persona
 * and nobody else.
 *
 * An EMPTY list refuses too, and that is not an oversight. A process pointed
 * at a database with no users has not proved it is pointed at a demo — an
 * empty production replica, a database whose migration has not landed, and a
 * typo'd `DATABASE_URL` all look exactly like this. The demo instance's
 * database is seeded before its API boots, so the legitimate case always has
 * the persona in it.
 */
export function assertDemoOnlyUsers(emails: readonly (string | null)[]): void {
  const foreign = foreignUserEmails(emails);
  if (foreign.length > 0) {
    throw new DemoModeRefused(
      `${DEMO_MODE_ENV_VAR}=1 refused: the database holds ${foreign.length} account(s) that are ` +
        `not the demo persona (${foreign.slice(0, 3).join(', ')}${foreign.length > 3 ? ', …' : ''}). ` +
        'Demo mode grants every anonymous visitor a session, so it may only run against a ' +
        'database seeded exclusively for the demo.'
    );
  }
  if (emails.length === 0) {
    throw new DemoModeRefused(
      `${DEMO_MODE_ENV_VAR}=1 refused: the database holds no users at all, so it cannot be ` +
        `shown to have been seeded for the demo. Seed it first: ` +
        'bun packages/business/domain/src/demo/cli.ts --anchor today'
    );
  }
}

/**
 * `assertDemoOnlyUsers` against the connected database. Called once, at boot.
 *
 * Takes an executor so a test can run it inside a rolled-back transaction and
 * watch the shipped query decide — a re-implementation of the read would agree
 * with whatever the read got wrong.
 */
export async function assertDemoOnlyDatabase(executor: DatabaseTransaction = db): Promise<void> {
  const rows = await executor.select({ email: schema.users.email }).from(schema.users);
  assertDemoOnlyUsers(rows.map((row) => row.email));
}

/**
 * `assertDemoOnlyUsers` without the empty-database refusal (SC-467).
 *
 * The two guards ask different questions and both answers are correct for
 * their caller. `assertDemoOnlyUsers` asks *"has this database been shown to
 * be a demo"*, because its caller is about to hand every anonymous visitor a
 * session — and emptiness proves nothing there. This one asks *"is there
 * anybody here I would destroy"*, because its caller is the first-boot seeder,
 * whose whole job is to fill a database that has nothing in it. Calling the
 * stricter guard from the seeder would refuse the only case the seeder exists
 * for, and a fresh demo deployment would never come up.
 *
 * Both refuse a foreign account, which is the case that matters: the seeder
 * deletes the demo user and lets the cascade run, and pointing it at a
 * database holding real people is the one failure with no undo.
 */
export function assertNoForeignUsers(emails: readonly (string | null)[]): void {
  const foreign = foreignUserEmails(emails);
  if (foreign.length === 0) return;
  throw new DemoModeRefused(
    `Refusing to seed the demo dataset: the database holds ${foreign.length} account(s) that are ` +
      `not the demo persona (${foreign.slice(0, 3).join(', ')}${foreign.length > 3 ? ', …' : ''}). ` +
      'Seeding deletes the demo user and everything cascading off them, so it may only run ' +
      'against a database dedicated to the demo.'
  );
}

/** `assertNoForeignUsers` against the connected database. */
export async function assertNoForeignUsersInDatabase(
  executor: DatabaseTransaction = db
): Promise<void> {
  const rows = await executor.select({ email: schema.users.email }).from(schema.users);
  assertNoForeignUsers(rows.map((row) => row.email));
}

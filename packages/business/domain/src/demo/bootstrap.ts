/**
 * First-boot seeding for a demo deployment (SC-467).
 *
 * SC-466 left the demo with a chicken-and-egg it could not hit locally,
 * because the local walkthrough seeded from a checkout before starting
 * anything. A deployed instance has no checkout: it runs the published
 * `scani/api` and `scani/worker` images, and neither carries the seeder CLI.
 * So on a freshly migrated database:
 *
 *   - the api reads `users`, finds it empty, and `process.exit(1)`s — that
 *     refusal is deliberate and must not be weakened (`assertDemoOnlyUsers`);
 *   - the worker's `demo-reset` schedule would fix it, at 06:00 UTC, which is
 *     up to 24 hours after the deploy.
 *
 * The worker is the right place to break that: it is the only demo process
 * that carries `DemoDatasetSeeder`, and it has no boot guard of its own to
 * satisfy first. So it seeds before arming the schedule, and the api's
 * crash-loop resolves itself on the next restart rather than needing an
 * operator with a checkout.
 *
 * **Only when the persona is absent.** An unconditional seed would rewrite
 * ~21,500 rows on every machine restart and host migration, and a demo that
 * rebuilds itself under a visitor for no reason is worse than one that does
 * not. The daily reset is what re-anchors to today; this only fills a
 * database that has nothing in it.
 */

import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { eq, sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { DemoDatasetSeeder } from './DemoDatasetSeeder';
import { assertNoForeignUsersInDatabase } from './mode';
import { DEMO_USER_EMAIL } from './persona';

const logger = createComponentLogger('demo-bootstrap');

export interface DemoBootstrapResult {
  /** True when this call wrote the dataset; false when it was already there. */
  readonly seeded: boolean;
  /** The anchor used, or the reason nothing was written. */
  readonly anchorDate?: string;
}

/** Today in UTC, as the seeder's `--anchor` wants it. */
export function todayAnchor(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Whether the demo persona already has a row. Case-insensitive, as emails are. */
export async function isDemoPersonaPresent(
  executor: Pick<typeof db, 'select'> = db
): Promise<boolean> {
  const rows = await executor
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(sql`lower(${schema.users.email})`, DEMO_USER_EMAIL.toLowerCase()))
    .limit(1);
  return rows.length > 0;
}

/**
 * Seeds the demo dataset if — and only if — the persona is missing.
 *
 * The guard is `assertNoForeignUsersInDatabase`, NOT `assertDemoOnlyDatabase`,
 * and the difference is the whole reason this function exists. The api's guard
 * refuses an empty database because nothing about emptiness proves a database
 * is a demo — an unmigrated database, an empty replica and a typo'd
 * `DATABASE_URL` all look identical. That is right for a process about to hand
 * every anonymous visitor a session. It is wrong here, where an empty database
 * is precisely the case being fixed. What this one must never do is destroy
 * somebody real, so it asks the narrower question: is anyone here who is not
 * the persona. Calling the api's guard would refuse exactly the case this
 * exists for, and the demo would never come up at all.
 */
export async function ensureDemoDatasetSeeded(
  now: Date = new Date()
): Promise<DemoBootstrapResult> {
  if (await isDemoPersonaPresent()) {
    logger.info({}, '🎭 Demo dataset already present — not reseeding at boot');
    return { seeded: false };
  }

  await assertNoForeignUsersInDatabase();

  const anchorDate = todayAnchor(now);
  const start = Date.now();
  const summary = await Container.get(DemoDatasetSeeder).seed({ anchorDate });
  logger.info(
    { anchorDate: summary.anchorDate, counts: summary.counts, totalMs: Date.now() - start },
    '🎭 Demo dataset seeded at boot'
  );
  return { seeded: true, anchorDate: summary.anchorDate };
}

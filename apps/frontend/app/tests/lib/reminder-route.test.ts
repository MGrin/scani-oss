import '../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { V3_ROUTES } from '../../src/v3/lib/routes';

/**
 * The reminder's tap target has to be a route this app still serves (SC-226).
 *
 * The worker composes the notification, so the URL inside it is a string
 * literal in `SendPaymentDueRemindersUseCase` — the route table is frontend
 * code and importing it there would drag the SPA into the worker's bundle.
 * That leaves the two free to drift, and drift here is invisible in the worst
 * possible place: a path v3 no longer routes falls through to the v2
 * cross-over, and in an installed PWA there is no URL bar to leave the wrong
 * screen by (SC-62, SC-71 5.2).
 *
 * Read as text rather than imported because `@scani/domain` pulls the database
 * layer in with it, and a frontend test has no business booting that.
 */

const USE_CASE = join(
  import.meta.dir,
  '../../../../../packages/business/domain/src/use-cases/SendPaymentDueRemindersUseCase.ts'
);

const TEST_USE_CASE = join(
  import.meta.dir,
  '../../../../../packages/business/domain/src/use-cases/SendTestNotificationUseCase.ts'
);

describe('payment reminder target path', () => {
  test('matches the Money route v3 actually registers', () => {
    const source = readFileSync(USE_CASE, 'utf8');
    const literal = source.match(/REMINDER_TARGET_PATH\s*=\s*'([^']+)'/)?.[1];

    // A parse that finds nothing must fail, not pass vacuously — a renamed
    // constant would otherwise silence this guard forever.
    expect(literal).toBeDefined();
    expect(literal).toBe(V3_ROUTES.money);
  });

  /**
   * The test notification (SC-322) has to reuse the constant, not carry a path
   * of its own — otherwise the guard above covers the reminder and not the
   * feature whose entire job is to prove the reminder works. A hand-rolled
   * send on 2026-08-16 used `/v3/money`, which v3 does not route and the
   * catch-all handed to the classic UI: a test that lands in the wrong
   * interface teaches the reader their notifications are broken when they are
   * not.
   */
  test('the test notification reuses the same path rather than repeating it', () => {
    const source = readFileSync(TEST_USE_CASE, 'utf8');

    expect(source).toContain('REMINDER_TARGET_PATH');
    // Any `url:` in the payload must be the imported constant. A literal here
    // is the exact drift this file exists to stop.
    expect(source.match(/url:\s*['"`]/)).toBeNull();
  });
});

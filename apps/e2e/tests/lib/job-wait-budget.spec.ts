import type { Page } from '@playwright/test';
import { expect, test } from '../../fixtures/test';
import { jobWaitTimeoutMessage, waitForJob } from '../../fixtures/ui';

/**
 * The `jobs.status` response `waitForJob` polls, with none of the rest of a
 * `Page`. Nothing here launches a browser: these tests are about which
 * deadline fires and what it says, and a real stack can answer neither
 * question on demand.
 */
function pageAlwaysReporting(state: string, body: Record<string, unknown> = {}): Page {
  const stub = {
    request: {
      get: async () => ({
        ok: () => true,
        status: () => 200,
        text: async () => '',
        json: async () => ({ result: { data: { state, ...body } } }),
      }),
    },
  };
  // The fixture reaches for `page.request.get` and nothing else; a real Page
  // would need a browser, which is the thing these tests exist to avoid.
  return stub as unknown as Page;
}

test.describe('suite: job-wait budget', () => {
  /**
   * THE REGRESSION TEST FOR SC-498, and the reason it looks upside-down.
   *
   * The test asks for a *shorter* budget than the wait it then performs — 5s
   * of test for an 8s wait. That is exactly the arrangement that used to be
   * unsurvivable, and it was the ordinary one: `playwright.config.ts` sets no
   * `timeout`, so every test got Playwright's 30s default while `waitForJob`
   * also defaulted to 30s and started later. Playwright's deadline therefore
   * won every time, and reported `Test timeout of 30000ms exceeded` against
   * whichever line of `fixtures/ui.ts` the fixture was awaiting — a message
   * that names test plumbing and says nothing about the worker.
   *
   * On the code before the fix this test does not fail an assertion, it is
   * KILLED at 5s. That is the point: the fixture must be able to outlive the
   * budget it was given, or its message can never be printed.
   */
  test('the fixture outlives the test budget it started with', async () => {
    test.setTimeout(5_000);
    const budgetBefore = test.info().timeout;

    await expect(
      waitForJob(pageAlwaysReporting('queued'), 'job-never-picked-up', { timeoutMs: 8_000 })
    ).rejects.toThrow(/never left the queue/);

    // Reserved = the wait itself plus the fixture's margin, added to whatever
    // the test already had. Asserting the arithmetic rather than "it grew"
    // keeps a future change to the margin from passing silently.
    expect(test.info().timeout).toBe(budgetBefore + 8_000 + 5_000);
  });

  /**
   * THE TEST A FUTURE READER WILL WANT TO DELETE, so the reason is here rather
   * than in a commit message: this looks like waste. The job finished on the
   * first poll, the test was never in danger, and reserving nine seconds
   * nobody used reads as something to make conditional.
   *
   * It cannot be conditional. How long the job will take is the quantity being
   * measured, so there is no "will I need it" to test — and Playwright exposes
   * a test's total budget but not how much of it has already elapsed, so
   * "the budget is already big enough" is not a question this fixture is able
   * to ask. A budget can only be raised BEFORE its deadline passes; once
   * Playwright has named the wrong cause there is no second chance to name the
   * right one. Unconditional is the only version that always works.
   */
  test('reserves the budget even when the job completes on the first poll', async () => {
    const budgetBefore = test.info().timeout;

    const status = await waitForJob(pageAlwaysReporting('completed', { returnvalue: null }), 'j', {
      timeoutMs: 30_000,
    });

    expect(status.state).toBe('completed');
    expect(test.info().timeout).toBe(budgetBefore + 30_000 + 5_000);
  });

  /**
   * The message has one job: separate "the worker did not finish" from "the
   * product is broken". `queued` at the deadline settles it — nothing picked
   * the job up, so no line of product code ran.
   */
  test('a job that never left the queue says so', () => {
    const message = jobWaitTimeoutMessage({
      jobId: 'abc',
      timeoutMs: 60_000,
      polls: 63,
      lastState: 'queued',
      pickedUpAfterMs: null,
    });

    expect(message).toContain('abc');
    expect(message).toContain('60s');
    expect(message).toContain('63 poll');
    expect(message).toContain('never left the queue');
    expect(message).toContain('never ran');
  });

  /**
   * And `active` must NOT settle it. A contended box and a processor stuck in
   * a loop are the same state from here, so the message reports what was seen
   * and stops. Wording that invited the reader to dismiss it would be how a
   * real regression gets absorbed into a known flake — worse than the flake,
   * because a flake at least stays visible.
   *
   * Asserted as an absence, which is unusual and deliberate: the failure this
   * guards against is a helpful sentence somebody adds later.
   */
  test('a job the worker picked up reports the state and draws no conclusion', () => {
    const message = jobWaitTimeoutMessage({
      jobId: 'abc',
      timeoutMs: 60_000,
      polls: 63,
      lastState: 'active',
      pickedUpAfterMs: 1_200,
    });

    expect(message).toContain('"active"');
    expect(message).toContain('1.2s');
    expect(message).toContain('neither finished nor failed');
    for (const dismissal of ['flake', 'flaky', 'ignore', 'contention', 'retry', 'harmless']) {
      expect(
        message.toLowerCase(),
        `message tells the reader to dismiss it: ${dismissal}`
      ).not.toContain(dismissal);
    }
  });
});

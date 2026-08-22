import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { describeJobFailure, type JobFailureCode, type JobFailureDescription } from '@scani/shared';
import i18n from 'i18next';
import v3En from '../../../src/v3/i18n/locales/en.json';
import v3Ru from '../../../src/v3/i18n/locales/ru.json';
import { jobFailureLabel, jobFailureSentence } from '../../../src/v3/lib/jobs';

/**
 * What a failed job is CALLED, now that the describer has stopped saying
 * (SC-424).
 *
 * `describeJobFailure` lives in `@scani/shared`, which the API and the worker
 * import — so it has no `t()` and every sentence it rendered was English a
 * translator could not reach. A Russian reader watching an import die was
 * handed "Failed — won't retry" beside four states that had just been
 * translated in SC-421. It answers with a code and its operands now, and the
 * naming happens here.
 *
 * Two claims:
 *
 * 1. **Nothing reads differently in English.** Every string below is the string
 *    the describer produced before the move, character for character — so the
 *    move is a refactor to an English reader and a fix to everyone else.
 *    One deliberate exception since SC-554: `unrecoverable` now has two
 *    wordings, and the one the describer used to produce is the
 *    `detailShown: true` half. The default changed on purpose — see the
 *    `detailShown` block at the bottom of this file.
 * 2. **Every code is named in every language.** `jobFailureLabel` builds its
 *    key from the code, so a code added without a locale entry puts
 *    `v3.jobs.failure.<code>.label` on a chip — worse than the English it
 *    replaced, and invisible to the locale-completeness suite, which compares
 *    Russian against English and would see both sides equally empty.
 */

const t = i18n.t.bind(i18n) as (key: string, vars?: Record<string, unknown>) => string;

/** Every branch of the describer, as the facts that reach it. */
const CASES: Array<{ code: JobFailureCode; facts: Parameters<typeof describeJobFailure>[0] }> = [
  { code: 'cancelled', facts: { state: 'failed', deadAt: new Date(), failureReason: 'cancelled' } },
  {
    code: 'neverDelivered',
    facts: { state: 'failed', deadAt: new Date(), failureReason: 'never_delivered' },
  },
  {
    code: 'unrecoverable',
    facts: { state: 'failed', deadAt: new Date(), failureReason: 'unrecoverable' },
  },
  {
    code: 'exhausted',
    facts: { state: 'failed', deadAt: new Date(), attemptsMade: 3, attemptsAllowed: 3 },
  },
  {
    code: 'noRetry',
    facts: { state: 'failed', deadAt: new Date(), attemptsMade: 1, attemptsAllowed: 1 },
  },
  {
    code: 'notQueued',
    facts: {
      state: 'failed',
      deadAt: null,
      attemptsMade: 1,
      attemptsAllowed: 3,
      queueHasJob: false,
    },
  },
  {
    code: 'retrying',
    facts: { state: 'failed', deadAt: null, attemptsMade: 1, attemptsAllowed: 3 },
  },
  {
    code: 'settling',
    facts: { state: 'failed', deadAt: null, attemptsMade: 3, attemptsAllowed: 3 },
  },
];

function describedFor(code: JobFailureCode): JobFailureDescription {
  const found = CASES.find((c) => c.code === code);
  const described = found ? describeJobFailure(found.facts) : null;
  if (!described) throw new Error(`no case produces ${code}`);
  return described;
}

describe('a failure is named, not rendered', () => {
  test('the cases cover every code the describer can answer with', () => {
    const produced = CASES.map((c) => describeJobFailure(c.facts)?.code);
    expect(produced).toEqual(CASES.map((c) => c.code));
    expect(new Set(produced).size).toBe(CASES.length);
  });

  test('English reads exactly as the describer used to render it', () => {
    expect(jobFailureSentence(t, describedFor('cancelled'))).toBe(
      'You stopped this job before it finished.'
    );
    expect(jobFailureSentence(t, describedFor('neverDelivered'))).toBe(
      'This job was never handed to the worker, so it never ran and nothing was changed. Start it again from where you began it.'
    );
    expect(jobFailureSentence(t, describedFor('unrecoverable'), { detailShown: true })).toBe(
      'This failed for a reason another attempt will not fix. Check the details below, correct them, and start it again.'
    );
    expect(jobFailureSentence(t, describedFor('exhausted'))).toBe(
      'This was tried 3 times and failed every time. It will not be tried again on its own.'
    );
    expect(jobFailureSentence(t, describedFor('noRetry'))).toBe(
      'This failed and will not be tried again on its own.'
    );
    expect(jobFailureSentence(t, describedFor('notQueued'))).toBe(
      'The last attempt failed, and no further attempt is queued for it.'
    );
    expect(jobFailureSentence(t, describedFor('retrying'))).toBe(
      'Attempt 1 of 3 failed. The next one starts automatically — nothing for you to do yet.'
    );
    expect(jobFailureSentence(t, describedFor('settling'))).toBe(
      'The last attempt failed. Checking whether anything else is queued for it.'
    );
  });

  test('the chip says which failure it is', () => {
    expect(jobFailureLabel(t, describedFor('retrying'))).toBe('Retrying (1 of 3)');
    expect(jobFailureLabel(t, describedFor('cancelled'))).toBe('Cancelled');
    expect(jobFailureLabel(t, describedFor('neverDelivered'))).toBe('Never started');
    expect(jobFailureLabel(t, describedFor('exhausted'))).toBe("Failed — won't retry");
    expect(jobFailureLabel(t, describedFor('settling'))).toBe('Failed');
  });

  /**
   * The whole point of the ticket. A missing key renders as the key itself,
   * and `jobFailureLabel` builds its key from the code — so a code added
   * without a locale entry puts `v3.jobs.failure.<code>.label` on a chip.
   */
  test('every code is answered in every language, not just English', () => {
    const bundles: Array<[string, Record<string, unknown>]> = [
      ['en', v3En],
      ['ru', v3Ru],
    ];
    const missing: string[] = [];
    for (const [code, bundle] of bundles) {
      const failure = (bundle as { v3: { jobs: { failure: Record<string, object> } } }).v3.jobs
        .failure;
      for (const c of CASES) {
        const entry = failure[c.code] as Record<string, string> | undefined;
        if (!entry) {
          missing.push(`${code}: ${c.code}`);
          continue;
        }
        if (!entry.label) missing.push(`${code}: ${c.code}.label`);
        // `exhausted` is the one pluralised sentence; the locale-completeness
        // suite is what checks its four Russian forms.
        const hasSentence = Object.keys(entry).some((k) => k.startsWith('sentence'));
        if (!hasSentence) missing.push(`${code}: ${c.code}.sentence`);
      }
    }
    expect(missing).toEqual([]);
  });

  test('Russian reaches the reader rather than falling back to English', async () => {
    await i18n.changeLanguage('ru');
    try {
      const ru = i18n.t.bind(i18n) as (key: string, vars?: Record<string, unknown>) => string;
      expect(jobFailureLabel(ru, describedFor('cancelled'))).toBe('Отменена');
      expect(jobFailureLabel(ru, describedFor('retrying'))).toBe('Повтор (1 из 3)');
      // 3 attempts is Russian's `few`, which English has no category for and
      // therefore cannot catch.
      expect(jobFailureSentence(ru, describedFor('exhausted'))).toContain('3 попытки');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

/**
 * The sentence may only name the detail block when the caller renders one
 * (SC-554).
 *
 * `JobDetailHeader` gates `job.userFacingError` on its own truthiness, so for
 * any throw nobody marked `userFacing(...)` the block is absent — and the one
 * wording `unrecoverable` had said "Check the details below, correct them, and
 * start it again". A reader was told to correct something that was not on the
 * page. The review feed's dead-job line has never had a detail block at all
 * and got the same sentence.
 *
 * These stay meaningful after the two unmarked worker throws
 * (`exchange-import.ts:243`, `wallet-import.ts:40`) are marked, and after the
 * last unmarked throw anywhere: `userFacingError` is nullable for every job at
 * the schema level, and `review-text.ts` passes no options at all, so the
 * `false` branch is reachable from a CALLER rather than from a processor's
 * choice. Marking every throw in the worker would not make this dead code.
 */
describe('detailShown decides whether the sentence may point at a detail block', () => {
  test('the default wording does not send the reader to a block that is not there', () => {
    expect(jobFailureSentence(t, describedFor('unrecoverable'))).toBe(
      'This failed for a reason another attempt will not fix, and nothing was recorded that we can show you. Re-running it unchanged will fail the same way.'
    );
  });

  test('the two wordings are genuinely different strings in every language', async () => {
    for (const lng of ['en', 'ru']) {
      await i18n.changeLanguage(lng);
      try {
        const tr = i18n.t.bind(i18n) as (key: string, vars?: Record<string, unknown>) => string;
        const plain = jobFailureSentence(tr, describedFor('unrecoverable'));
        const withDetail = jobFailureSentence(tr, describedFor('unrecoverable'), {
          detailShown: true,
        });
        expect(plain).not.toBe(withDetail);
        // Deliberately NOT also asserting the result is not a raw `v3.*` key.
        // `fallbackLng` is `en`, so a locale missing `sentenceWithDetail`
        // renders the English sentence rather than the key — measured by
        // deleting the Russian entry, which left this file 8/8 green. That
        // assertion could never fire, and a guard that cannot fire is
        // decoration. `tests/lib/i18n-locales.test.ts` owns the missing-key
        // case and does catch it, naming
        // `ru: v3.jobs.failure.unrecoverable.sentenceWithDetail`.
      } finally {
        await i18n.changeLanguage('en');
      }
    }
  });

  test('only unrecoverable reads the flag — every other code is unmoved by it', () => {
    for (const { code } of CASES) {
      if (code === 'unrecoverable') continue;
      expect(jobFailureSentence(t, describedFor(code), { detailShown: true })).toBe(
        jobFailureSentence(t, describedFor(code))
      );
    }
  });
});

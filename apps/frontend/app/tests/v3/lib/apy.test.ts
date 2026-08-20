import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { PAYOUTS_PER_YEAR, PayoutFrequency } from '@scani/shared';
import { parseAmountInput } from '@scani/ui/v3/lib/amount-input';
import i18n from 'i18next';
import {
  type ApyDraft,
  apyBlockers,
  apyConfigInput,
  apyDayNote,
  apyDraftFromConfig,
  apyPreviewSentence,
  frequencyLabelKey,
  monthlyDayClamps,
  needsDayOfMonth,
  needsDayOfWeek,
  needsMonth,
  nextPayoutAmount,
  PAYOUT_FREQUENCIES,
  parseDayOfMonth,
  parseRatePct,
  yearlyDayClamps,
} from '@/v3/lib/apy';

const t = i18n.t.bind(i18n);

function draft(over: Partial<ApyDraft> = {}): ApyDraft {
  return { rate: '4.5', frequency: 'monthly', dayOfWeek: 1, dayOfMonth: '1', month: 1, ...over };
}

describe('the rate', () => {
  test('a rate below 1% is a value, not a rejected keystroke', () => {
    // v2's defect, stated as the thing it prevented: `isAllowed: floatValue > 0`
    // runs on the `0` of `0.5` and swallows it, so a 0.5% savings account
    // cannot be configured at all.
    expect(parseRatePct('0.5')).toBe(0.5);
    expect(parseRatePct('0.05')).toBe(0.05);
  });

  test('the bounds are the DTO’s — above 0, up to and including 100', () => {
    expect(parseRatePct('0')).toBeNull();
    expect(parseRatePct('100')).toBe(100);
    expect(parseRatePct('100.01')).toBeNull();
    expect(parseRatePct('-1')).toBeNull();
  });

  test('a decimal COMMA reaches this function as a decimal point (SC-413)', () => {
    // `parseRatePct` is `Number(value)` and `Number('4,5')` is NaN, so the
    // question is not what it does with a comma — it is whether a comma can
    // ever reach it. It cannot: the field is an `AmountInput`, whose whole
    // subject is that both separators are the reader's (SC-75), and the draft
    // holds the canonical string it produces rather than the typed text.
    //
    // Asserted through the real parser rather than by writing `'4.5'` here,
    // because the claim is about the two halves agreeing. A field swapped back
    // to a plain `<Input>` would fail this, which is the regression a Russian
    // reader reported the shape of: `4,5` typed, «укажите годовую ставку»
    // back, and nothing on screen saying the comma was the problem.
    for (const typed of ['4,5', '0,5', '12,75', '100,0']) {
      const { value } = parseAmountInput(typed, { decimalScale: 4 });
      expect(parseRatePct(value)).toBe(Number(typed.replace(',', '.')));
    }
  });

  test('blank and nonsense are missing, not zero', () => {
    expect(parseRatePct('')).toBeNull();
    expect(parseRatePct('   ')).toBeNull();
    expect(parseRatePct('abc')).toBeNull();
  });

  test('the payload carries the reader’s own string, not a re-serialised float', () => {
    expect(apyConfigInput(draft({ rate: '0.1' }))?.annualRatePct).toBe('0.1');
    expect(apyConfigInput(draft({ rate: ' 4.5 ' }))?.annualRatePct).toBe('4.5');
  });
});

describe('the day of the month', () => {
  test('a cleared field is missing rather than the 1st', () => {
    // v2 runs `Number.parseInt('')`, gets NaN, and substitutes 1 — so clearing
    // the field to retype 15 and submitting early books the payout on the 1st
    // with nothing having said so.
    expect(parseDayOfMonth('')).toBeNull();
    expect(apyConfigInput(draft({ frequency: 'monthly', dayOfMonth: '' }))).toBeNull();
    expect(apyBlockers(t, draft({ frequency: 'monthly', dayOfMonth: '' }))).toEqual([
      'enter a day of the month between 1 and 31',
    ]);
  });

  test('1-31 only, whole days only', () => {
    expect(parseDayOfMonth('1')).toBe(1);
    expect(parseDayOfMonth('31')).toBe(31);
    expect(parseDayOfMonth('0')).toBeNull();
    expect(parseDayOfMonth('32')).toBeNull();
    expect(parseDayOfMonth('15.5')).toBeNull();
  });

  test('a frequency that does not use it is not blocked by it', () => {
    expect(apyBlockers(t, draft({ frequency: 'daily', dayOfMonth: '' }))).toEqual([]);
    expect(apyBlockers(t, draft({ frequency: 'weekly', dayOfMonth: '' }))).toEqual([]);
  });
});

describe('which fields a frequency uses', () => {
  test('matches the DTO’s three conditions', () => {
    expect(PAYOUT_FREQUENCIES.filter(needsDayOfWeek)).toEqual(['weekly']);
    expect(PAYOUT_FREQUENCIES.filter(needsDayOfMonth)).toEqual(['monthly', 'yearly']);
    expect(PAYOUT_FREQUENCIES.filter(needsMonth)).toEqual(['yearly']);
  });

  test('the payload nulls by frequency, not by what the reader touched', () => {
    // Someone who looks at Monthly, sets day 15, then switches to Weekly must
    // not send a weekly schedule carrying a day-of-month — the DTO accepts it
    // and the job ignores it, so the stored row would describe two schedules.
    const weekly = apyConfigInput(draft({ frequency: 'weekly', dayOfWeek: 3, dayOfMonth: '15' }));
    expect(weekly).toEqual({
      annualRatePct: '4.5',
      payoutFrequency: 'weekly',
      payoutDayOfWeek: 3,
      payoutDayOfMonth: null,
      payoutMonth: null,
    });

    const yearly = apyConfigInput(
      draft({ frequency: 'yearly', dayOfWeek: 3, dayOfMonth: '15', month: 4 })
    );
    expect(yearly).toEqual({
      annualRatePct: '4.5',
      payoutFrequency: 'yearly',
      payoutDayOfWeek: null,
      payoutDayOfMonth: 15,
      payoutMonth: 4,
    });
  });

  test('the picker offers exactly the enum, and every one of them has a name', () => {
    // The picker is generated from the DTO's enum, so this fails on the commit
    // that adds a frequency without copy rather than at the reader.
    expect([...PAYOUT_FREQUENCIES]).toEqual([...PayoutFrequency.options]);
    for (const code of PAYOUT_FREQUENCIES) {
      const key = frequencyLabelKey(code);
      expect(i18n.exists(key)).toBe(true);
      expect(t(key)).not.toBe(key);
    }
  });
});

describe('blockers and submittability cannot disagree', () => {
  test('no blockers means a payload, blockers mean none', () => {
    for (const candidate of [
      draft(),
      draft({ rate: '' }),
      draft({ rate: '101' }),
      draft({ frequency: 'monthly', dayOfMonth: '' }),
      draft({ frequency: 'yearly', dayOfMonth: '99' }),
      draft({ frequency: 'daily', rate: '0.01' }),
    ]) {
      expect(apyConfigInput(candidate) === null).toBe(apyBlockers(t, candidate).length > 0);
    }
  });

  test('every blocker is a phrase that completes "To continue: …"', () => {
    for (const phrase of apyBlockers(
      t,
      draft({ rate: '', frequency: 'monthly', dayOfMonth: '' })
    )) {
      expect(phrase).not.toBe('');
      expect(phrase[0]).toBe(phrase[0]?.toLowerCase());
      expect(phrase.endsWith('.')).toBe(false);
    }
  });
});

describe('what the form opens with', () => {
  test('no config is v2’s defaults — monthly, the 1st, Monday, no rate', () => {
    expect(apyDraftFromConfig()).toEqual({
      rate: '',
      frequency: 'monthly',
      dayOfWeek: 1,
      dayOfMonth: '1',
      month: 1,
    });
  });

  test('an existing config round-trips back out unchanged', () => {
    const config = {
      annualRatePct: '3.25',
      payoutFrequency: 'yearly',
      payoutDayOfWeek: null,
      payoutDayOfMonth: 20,
      payoutMonth: 6,
    };
    expect(apyConfigInput(apyDraftFromConfig(config))).toEqual({
      annualRatePct: '3.25',
      payoutFrequency: 'yearly',
      payoutDayOfWeek: null,
      payoutDayOfMonth: 20,
      payoutMonth: 6,
    });
  });

  test('a frequency the client does not know falls back rather than crashing', () => {
    // The column is `text`, so a row written by a future server is reachable.
    expect(
      apyDraftFromConfig({
        annualRatePct: '1',
        payoutFrequency: 'fortnightly',
        payoutDayOfWeek: null,
        payoutDayOfMonth: 3,
        payoutMonth: null,
      }).frequency
    ).toBe('monthly');
  });
});

describe('the next payout', () => {
  test('is the job’s own first iteration — balance × rate ÷ payouts per year', () => {
    // `ApplyApyPayoutsUseCase`: `runningBalance.mul(rate).div(perYear)`, with
    // `rate = annualRatePct / 100` and the first iteration over the current
    // balance. Asserted against the shared table rather than a literal so the
    // two cannot drift apart silently.
    expect(nextPayoutAmount(10_000, 4.5, 'monthly')).toBeCloseTo(
      (10_000 * 0.045) / PAYOUTS_PER_YEAR.monthly,
      10
    );
    expect(nextPayoutAmount(10_000, 4.5, 'yearly')).toBe(450);
    expect(nextPayoutAmount(10_000, 4.5, 'daily')).toBeCloseTo(450 / 365, 10);
    expect(nextPayoutAmount(10_000, 4.5, 'weekdays')).toBeCloseTo(450 / 260, 10);
  });

  test('a zero balance pays zero rather than NaN', () => {
    expect(nextPayoutAmount(0, 4.5, 'monthly')).toBe(0);
  });
});

describe('the clamp the job applies, said out loud', () => {
  test('a monthly day past 28 lands early in some month', () => {
    expect(monthlyDayClamps(28)).toBe(false);
    expect(monthlyDayClamps(29)).toBe(true);
    expect(monthlyDayClamps(31)).toBe(true);
    expect(monthlyDayClamps(null)).toBe(false);
  });

  test('a yearly day is judged against its own month, in the reader’s own year', () => {
    expect(yearlyDayClamps(31, 1, 2026)).toBe(false); // January has 31
    expect(yearlyDayClamps(31, 4, 2026)).toBe(true); // April has 30
    expect(yearlyDayClamps(30, 2, 2026)).toBe(true); // February never has 30
    // The leap year is why the year is a parameter at all: the 29th is past
    // the end of February in 2026 and is not in 2028.
    expect(yearlyDayClamps(29, 2, 2026)).toBe(true);
    expect(yearlyDayClamps(29, 2, 2028)).toBe(false);
  });
});

describe('the summary the form exists to add', () => {
  const holding = { amount: 10_000, symbol: 'EUR' };

  test('names the schedule and the size of the next payout', () => {
    expect(apyPreviewSentence(t, draft({ rate: '4.5', dayOfMonth: '15' }), holding)).toBe(
      'Monthly on day 15. At today’s balance the next payout is about 37.50 EUR.'
    );
  });

  test('the frequency changes the figure, which is why the field is there', () => {
    expect(
      apyPreviewSentence(t, draft({ rate: '4.5', frequency: 'yearly', month: 6 }), holding)
    ).toContain('450.00 EUR');
    expect(apyPreviewSentence(t, draft({ rate: '4.5', frequency: 'daily' }), holding)).toContain(
      '1.23 EUR'
    );
  });

  test('a dust payout keeps its digits rather than reading as nothing', () => {
    // `moneyDecimals` lifts past two only when two would render zero — the
    // alternative here is a form promising "about 0.00".
    expect(apyPreviewSentence(t, draft({ rate: '0.5' }), { amount: 1, symbol: 'BTC' })).toContain(
      '0.000416'
    );
  });

  test('an impossible date is never asserted', () => {
    // 31 February is accepted by the DTO and paid on the 28th — or the 29th.
    // The note under the field explains the clamp; the sentence beside it must
    // not simultaneously claim a day that never arrives.
    expect(
      apyPreviewSentence(
        t,
        draft({ frequency: 'yearly', month: 2, dayOfMonth: '31' }),
        holding,
        2026
      )
    ).toBe(
      'Yearly on the last day of February. At today’s balance the next payout is about 450.00 EUR.'
    );
    // 29 February exists in 2028, so that year names the day.
    expect(
      apyPreviewSentence(
        t,
        draft({ frequency: 'yearly', month: 2, dayOfMonth: '29' }),
        holding,
        2028
      )
    ).toContain('Yearly on 29 February');
  });

  test('there is no sentence until there is a schedule to describe', () => {
    expect(apyPreviewSentence(t, draft({ rate: '' }), holding)).toBeNull();
    expect(apyPreviewSentence(t, draft({ dayOfMonth: '' }), holding)).toBeNull();
    // Weekly does not use the day of the month, so a blank one does not
    // withhold the sentence.
    expect(
      apyPreviewSentence(t, draft({ frequency: 'weekly', dayOfMonth: '' }), holding)
    ).toContain('Weekly on Monday');
  });
});

describe('the note under the day field', () => {
  test('is silent when nothing is clamped', () => {
    expect(apyDayNote(t, draft({ dayOfMonth: '15' }), 2026)).toBeNull();
    expect(apyDayNote(t, draft({ frequency: 'daily' }), 2026)).toBeNull();
    expect(apyDayNote(t, draft({ frequency: 'weekly' }), 2026)).toBeNull();
  });

  test('a monthly schedule past the 28th says shorter months pay early', () => {
    expect(apyDayNote(t, draft({ dayOfMonth: '31' }), 2026)).toBe(
      'Shorter months pay on their last day.'
    );
  });

  test('a yearly schedule names the month it overruns', () => {
    expect(apyDayNote(t, draft({ frequency: 'yearly', month: 2, dayOfMonth: '30' }), 2026)).toBe(
      'February ends before that, so this pays on its last day.'
    );
    // 31 January is a real date, so there is nothing to warn about.
    expect(
      apyDayNote(t, draft({ frequency: 'yearly', month: 1, dayOfMonth: '31' }), 2026)
    ).toBeNull();
  });
});

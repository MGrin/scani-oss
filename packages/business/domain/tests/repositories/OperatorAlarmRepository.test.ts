import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { OperatorAlarmRepository } from '../../src/repositories/OperatorAlarmRepository';
import { withTestDb } from '../../test/helpers/db';

// The ledger that makes an operator alarm fire on ENTERING a condition rather
// than on every probe that observes it (SC-870).
//
// The failure this replaces is not "an unpleasant stream". A condition that
// repeats hourly outnumbers everything else a service reports, and what that
// costs is the low-frequency signal underneath it — something that fails once a
// day goes unread for as long as the loud condition lasts. A persistent
// condition MANUFACTURES A HIDING PLACE, and the alarm is what has to stop
// doing that.
//
// So the two properties below are the whole contract, and each is written so it
// can only pass for the right reason:
//   - a condition that persists fires ONCE, not once per probe;
//   - a condition that clears and returns fires AGAIN.
// Suppressing the repeat without the second is worse than the bug: it also
// suppresses a genuine re-entry, which is the event most worth having.

const repo = () => Container.get(OperatorAlarmRepository);

const HOUR = 60 * 60 * 1000;
const WEEK = 7 * 24 * HOUR;

// Distinct per test, so two tests can never read each other's rows even if a
// rollback were to fail. `alarm` is the whole key space here.
let seq = 0;
const alarm = () => `test-alarm-${process.pid}-${++seq}`;

describe('OperatorAlarmRepository.sync', () => {
  test('a condition that persists fires once, not once per probe', async () => {
    await withTestDb(async (tx) => {
      const a = alarm();
      const at = (hours: number) => new Date(Date.UTC(2026, 0, 1, hours));

      const first = await repo().sync(a, ['cred-1'], { now: at(0), renotifyAfterMs: WEEK }, tx);
      const second = await repo().sync(a, ['cred-1'], { now: at(1), renotifyAfterMs: WEEK }, tx);
      const third = await repo().sync(a, ['cred-1'], { now: at(2), renotifyAfterMs: WEEK }, tx);

      expect(first.entered).toEqual(['cred-1']);
      expect(second.entered).toEqual([]);
      expect(second.restated).toEqual([]);
      expect(third.entered).toEqual([]);
      expect(third.restated).toEqual([]);
      // Still true, still open — silence here is suppression, not recovery, and
      // the caller can tell the two apart.
      expect(third.suppressed).toEqual(['cred-1']);
      expect(third.cleared).toEqual([]);
    });
  });

  test('a condition that clears and returns fires again', async () => {
    await withTestDb(async (tx) => {
      const a = alarm();
      const at = (hours: number) => new Date(Date.UTC(2026, 0, 1, hours));

      const broke = await repo().sync(a, ['cred-1'], { now: at(0), renotifyAfterMs: WEEK }, tx);
      const fixed = await repo().sync(a, [], { now: at(1), renotifyAfterMs: WEEK }, tx);
      const brokeAgain = await repo().sync(
        a,
        ['cred-1'],
        { now: at(2), renotifyAfterMs: WEEK },
        tx
      );

      expect(broke.entered).toEqual(['cred-1']);
      expect(fixed.cleared).toEqual(['cred-1']);
      expect(fixed.entered).toEqual([]);
      // A second entry, not a re-statement: recovery reset how long it has been
      // true, and `opened_at` is the field that carries that.
      expect(brokeAgain.entered).toEqual(['cred-1']);
      expect(brokeAgain.restated).toEqual([]);
    });
  });

  test('a condition that never clears is re-stated once per renotify window', async () => {
    await withTestDb(async (tx) => {
      const a = alarm();
      const start = new Date(Date.UTC(2026, 0, 1));
      const after = (ms: number) => new Date(start.getTime() + ms);

      const first = await repo().sync(a, ['cred-1'], { now: start, renotifyAfterMs: WEEK }, tx);
      const nearly = await repo().sync(
        a,
        ['cred-1'],
        { now: after(WEEK - HOUR), renotifyAfterMs: WEEK },
        tx
      );
      const due = await repo().sync(
        a,
        ['cred-1'],
        { now: after(WEEK + HOUR), renotifyAfterMs: WEEK },
        tx
      );
      const soonAfter = await repo().sync(
        a,
        ['cred-1'],
        { now: after(WEEK + 2 * HOUR), renotifyAfterMs: WEEK },
        tx
      );

      expect(first.entered).toEqual(['cred-1']);
      expect(nearly.restated).toEqual([]);
      // Re-stated, NOT entered — the caller can say “still broken” rather than
      // reporting a week-old condition as news.
      expect(due.restated).toEqual(['cred-1']);
      expect(due.entered).toEqual([]);
      // The window restarts from the re-statement, not from the first entry —
      // otherwise every probe past the first window fires forever, which is the
      // original bug with a week's delay.
      expect(soonAfter.restated).toEqual([]);
      expect(soonAfter.entered).toEqual([]);
    });
  });

  test('keys are independent: one clearing does not re-arm another', async () => {
    await withTestDb(async (tx) => {
      const a = alarm();
      const at = (hours: number) => new Date(Date.UTC(2026, 0, 1, hours));

      await repo().sync(a, ['cred-1', 'cred-2'], { now: at(0), renotifyAfterMs: WEEK }, tx);
      const next = await repo().sync(a, ['cred-2'], { now: at(1), renotifyAfterMs: WEEK }, tx);
      const back = await repo().sync(
        a,
        ['cred-1', 'cred-2'],
        { now: at(2), renotifyAfterMs: WEEK },
        tx
      );

      expect(next.cleared).toEqual(['cred-1']);
      expect(next.entered).toEqual([]);
      expect(next.suppressed).toEqual(['cred-2']);
      // cred-1 is news again; cred-2 has been open throughout and is not.
      expect(back.entered).toEqual(['cred-1']);
      expect(back.suppressed).toEqual(['cred-2']);
    });
  });

  test('one alarm clearing does not touch another alarm', async () => {
    await withTestDb(async (tx) => {
      const mine = alarm();
      const other = alarm();
      const at = (hours: number) => new Date(Date.UTC(2026, 0, 1, hours));

      await repo().sync(mine, ['k'], { now: at(0), renotifyAfterMs: WEEK }, tx);
      await repo().sync(other, ['k'], { now: at(0), renotifyAfterMs: WEEK }, tx);

      const cleared = await repo().sync(mine, [], { now: at(1), renotifyAfterMs: WEEK }, tx);
      const untouched = await repo().sync(other, ['k'], { now: at(1), renotifyAfterMs: WEEK }, tx);

      expect(cleared.cleared).toEqual(['k']);
      expect(untouched.entered).toEqual([]);
      expect(untouched.restated).toEqual([]);
      expect(untouched.suppressed).toEqual(['k']);
    });
  });

  test('an empty condition on a never-seen alarm is a no-op, not a firing', async () => {
    await withTestDb(async (tx) => {
      const result = await repo().sync(alarm(), [], { now: new Date(), renotifyAfterMs: WEEK }, tx);
      expect(result).toEqual({ entered: [], restated: [], cleared: [], suppressed: [] });
    });
  });
});

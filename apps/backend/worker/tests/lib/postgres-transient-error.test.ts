import { describe, expect, test } from 'bun:test';
import {
  isPostgresTransientError,
  PostgresTransientReport,
} from '../../src/lib/postgres-transient-error';

describe('isPostgresTransientError', () => {
  test('the SC-1231 crash, whose receiver the minifier named Y', () => {
    expect(isPostgresTransientError("null is not an object (evaluating 'Y.write')")).toBe(true);
  });

  test('the original crash, named v — the name is not part of the match', () => {
    expect(isPostgresTransientError("null is not an object (evaluating 'v.write')")).toBe(true);
    expect(isPostgresTransientError("null is not an object (evaluating 'socket.write')")).toBe(
      true
    );
  });

  test('the V8 spelling of the same dereference', () => {
    expect(isPostgresTransientError("Cannot read properties of null (reading 'write')")).toBe(true);
  });

  test('the driver errors it already covered', () => {
    expect(isPostgresTransientError('write CONNECTION_CLOSED ep-x.neon.tech:5432')).toBe(true);
    expect(isPostgresTransientError('write after end')).toBe(true);
  });

  // The control: a whitelist that matched every null dereference would keep a
  // worker alive over real bugs, which is what the exit path exists to stop.
  test('a null dereference of anything but write still exits', () => {
    expect(isPostgresTransientError("null is not an object (evaluating 'Y.send')")).toBe(false);
    expect(isPostgresTransientError("Cannot read properties of null (reading 'id')")).toBe(false);
    expect(isPostgresTransientError("undefined is not an object (evaluating 'Y.write')")).toBe(
      false
    );
  });
});

describe('how a handled connection drop is reported (SC-1738)', () => {
  const HOUR = 3_600_000;
  type Event = { level?: string; message?: string; exception?: { values: { value: string }[] } };
  const drop = (value = "null is not an object (evaluating 'v.write')"): Event => ({
    level: 'fatal',
    exception: { values: [{ value }] },
  });

  test("a drop the handler survives is a warning: Neon's suspends are routine", () => {
    expect(new PostgresTransientReport().adjust(drop(), 0).level).toBe('warning');
  });

  test('CONTROL: any other error keeps its level', () => {
    const report = new PostgresTransientReport();
    const other = drop("null is not an object (evaluating 'Y.send')");
    expect(report.adjust(other, 0).level).toBe('fatal');
    expect(report.adjust<Event>({ level: 'error', message: 'boom' }, 0).level).toBe('error');
  });

  test('a sixth drop within an hour is an error again: that is not a routine suspend', () => {
    const report = new PostgresTransientReport();
    const levels = [0, 1, 2, 3, 4, 5].map((i) => report.adjust(drop(), i * 60_000).level);
    expect(levels).toEqual(['warning', 'warning', 'warning', 'warning', 'warning', 'error']);
  });

  test('CONTROL: six drops spread over more than an hour stay warnings', () => {
    const report = new PostgresTransientReport();
    const levels = [0, 1, 2, 3, 4, 5].map((i) => report.adjust(drop(), i * (HOUR / 5 + 1)).level);
    expect(levels.every((l) => l === 'warning')).toBe(true);
  });
});

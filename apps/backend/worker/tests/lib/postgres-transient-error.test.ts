import { describe, expect, test } from 'bun:test';
import { isPostgresTransientError } from '../../src/lib/postgres-transient-error';

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

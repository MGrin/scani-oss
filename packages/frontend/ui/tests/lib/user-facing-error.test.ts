import { describe, expect, it } from 'bun:test';
import { ChunkLoadError } from '../../src/lib/lazy-chunk';
import {
  rejectionReason,
  UserFacingError,
  userFacingMessage,
} from '../../src/lib/user-facing-error';

/**
 * Which errors are allowed to speak to a reader (SC-311).
 *
 * The defect this pins is that the app could not tell a sentence somebody
 * WROTE for a reader from an assertion a programmer wrote for themselves.
 * Both are `Error`, both carry a `message`, and every renderer took the
 * message — so `useTheme must be used within a ThemeProvider` reached the
 * screen under "Something went wrong", untranslatable, with no way out of it
 * in the installed PWA (SC-62, SC-73).
 *
 * The fix is a marker, not a filter: nothing is shown unless somebody opted
 * it in. So the tests come in pairs — the deliberate message survives, its
 * accidental twin does not.
 */

/** Shaped like a `TRPCClientError`, without importing one. `data.httpStatus`
 *  is the structural fact that separates "our server answered" from "a
 *  component threw"; every test below that expects a message to survive
 *  depends on it being present. */
function trpcError(message: string, httpStatus: number | null = 400): Error {
  const error = new Error(message);
  Object.assign(error, { data: httpStatus === null ? {} : { httpStatus } });
  return error;
}

describe('userFacingMessage — deliberate messages survive', () => {
  it('returns a UserFacingError message', () => {
    expect(userFacingMessage(new UserFacingError('Nothing to export'))).toBe('Nothing to export');
  });

  it('returns a string handed straight to it', () => {
    // `showError('…')` — the caller already translated it, so it is theirs.
    expect(userFacingMessage('DeFiLlama results need a contract address.')).toBe(
      'DeFiLlama results need a contract address.'
    );
  });

  it('returns a ChunkLoadError sentence, because a failed chunk is a real answer', () => {
    const message = userFacingMessage(new ChunkLoadError('Excel writer', new Error('404')));
    expect(message).not.toBeNull();
    expect(message).toContain('Excel writer');
  });

  it('keeps a short rejection our own server wrote for the reader (SC-140)', () => {
    expect(userFacingMessage(trpcError('Kraken rejected request: EAPI:Invalid key'))).toBe(
      'Kraken rejected request: EAPI:Invalid key'
    );
  });
});

describe('userFacingMessage — accidents do not reach a reader', () => {
  it('refuses a hook-contract assertion', () => {
    expect(userFacingMessage(new Error('useTheme must be used within a ThemeProvider'))).toBeNull();
  });

  it('refuses an argument assertion', () => {
    expect(
      userFacingMessage(new Error('snapPoints must contain at least one value in (0, 1]'))
    ).toBeNull();
  });

  it('refuses a TypeError from a dependency', () => {
    expect(userFacingMessage(new TypeError('x.map is not a function'))).toBeNull();
  });

  it('refuses a message with no server envelope, however readable it looks', () => {
    // The shape rules alone would pass this. Only `data.httpStatus` — a fact
    // about where the error came from, not about how its text reads — lets a
    // message through, because a component's throw can be a tidy sentence too.
    expect(userFacingMessage(new Error('Kraken rejected request: EAPI:Invalid key'))).toBeNull();
  });

  it('refuses null, undefined and an empty string', () => {
    expect(userFacingMessage(null)).toBeNull();
    expect(userFacingMessage(undefined)).toBeNull();
    expect(userFacingMessage('   ')).toBeNull();
  });

  it('refuses a UserFacingError somebody threw with no message', () => {
    expect(userFacingMessage(new UserFacingError(''))).toBeNull();
  });
});

describe('rejectionReason — the shape rules, shared with describeQueryError', () => {
  it('refuses a serialised zod issue list', () => {
    expect(rejectionReason(trpcError('[{"code":"too_small","minimum":1}]'))).toBeNull();
  });

  it('refuses a bare tRPC code', () => {
    expect(rejectionReason(trpcError('BAD_REQUEST'))).toBeNull();
  });

  it('refuses a multi-line message, which was written for a log', () => {
    expect(rejectionReason(trpcError('Failed\n  at handler (index.ts:12)'))).toBeNull();
  });

  it('refuses a message too long to read in a toast', () => {
    expect(rejectionReason(trpcError('x'.repeat(201)))).toBeNull();
  });

  it('keeps a short single-line sentence', () => {
    expect(rejectionReason(trpcError('This transfer was already answered.'))).toBe(
      'This transfer was already answered.'
    );
  });
});

describe('UserFacingError', () => {
  it('is an Error, so every existing catch still works', () => {
    expect(new UserFacingError('x')).toBeInstanceOf(Error);
  });

  it('keeps the cause, so the console and Sentry still get the real failure', () => {
    const cause = new Error('Failed to fetch');
    expect(new UserFacingError('Could not reach the server', { cause }).cause).toBe(cause);
  });

  it('covers ChunkLoadError, which is a failure worded for a reader', () => {
    expect(new ChunkLoadError('Excel writer', null)).toBeInstanceOf(UserFacingError);
  });
});

import { describe, expect, it } from 'bun:test';
import { ChunkLoadError, importChunk, isChunkLoadError } from '../../src/lib/lazy-chunk';

/**
 * `importChunk` exists because SC-132 relaxed the top-level-import ban for
 * frontend route splitting, and the condition attached to that relaxation was
 * that **a failed chunk fetch must be handled**. An unhandled rejection inside
 * React's render path is a white screen with no message and no button — the
 * SC-62 shape.
 *
 * So these are tests of the failure, not of the success: what a reader is told
 * when a chunk does not arrive.
 *
 * ## The test this file used to lead with is deleted, and that is the point
 *
 * It read *"re-invokes the factory rather than re-awaiting a rejected
 * promise"*, and it passed a stub that threw twice and then returned a value —
 * asserting `calls === 3`. Every claim in it was true about the stub and none
 * of it was true in a browser. **A closure issues a fresh call every time by
 * construction**, so the test could not have failed however the module map
 * behaves, and it is what made a retry loop that issued exactly one network
 * request look protective for as long as it did (SC-890).
 *
 * Nothing replaces it here, because nothing in this process can: the module map
 * is the browser's, and a stub is not one. The measurement lives on SC-890 and
 * was taken in Chromium 148, WebKit 26.4 and Brave 152, against both the dev
 * server and a production build. The behaviour that *can* be tested — the one
 * document reload that is now the recovery, and the guard that stops it
 * looping — is in `apps/frontend/app/tests/lib/chunk-reload.test.ts`.
 */

describe('importChunk', () => {
  it('returns the module when it arrives, and calls the factory once', async () => {
    let calls = 0;
    const result = await importChunk(
      async () => {
        calls += 1;
        return { value: 'loaded' };
      },
      { chunk: 'test chunk' }
    );

    expect(result).toEqual({ value: 'loaded' });
    expect(calls).toBe(1);
  });

  it('asks exactly once, because a second ask could not reach the network', async () => {
    // The old loop made three calls here. Two of them could never have issued a
    // request — they would have hit the module map entry the first rejected
    // fetch left behind — so all they cost was 750 ms of backoff in front of
    // somebody already watching a spinner.
    let calls = 0;
    const failing = importChunk(
      async () => {
        calls += 1;
        throw new TypeError('Failed to fetch dynamically imported module: /V3App-abc123.js');
      },
      { chunk: 'interface' }
    );

    await expect(failing).rejects.toThrow(ChunkLoadError);
    expect(calls).toBe(1);
  });

  it('fails with something a person can read', async () => {
    const failing = importChunk(
      async () => {
        throw new TypeError('Failed to fetch dynamically imported module: /Excel-abc123.js');
      },
      { chunk: 'Excel writer' }
    );

    await expect(failing).rejects.toThrow(ChunkLoadError);

    const error = await failing.catch((e: unknown) => e as ChunkLoadError);
    // Named, actionable, and free of the hashed filename — the reader cannot do
    // anything with `/Excel-abc123.js` and every caller renders this verbatim.
    expect(error.message).toContain('Excel writer');
    expect(error.message).toContain('Check your connection');
    expect(error.message).toContain('reloading the page');
    expect(error.message).not.toContain('abc123');
    // The original is kept for Sentry and the console, just not shown.
    expect((error.cause as Error).message).toContain('abc123');
  });

  it('does not resolve fast enough to be doing nothing — it awaits the load', async () => {
    // Guards the shape of the rewrite rather than its wording: a version that
    // dropped the `await` would return a promise-of-a-promise and every caller
    // would render a pending module as a component.
    let resolved = false;
    const result = await importChunk(
      () =>
        new Promise((r) =>
          setTimeout(() => {
            resolved = true;
            r('late');
          }, 10)
        ),
      { chunk: 'test chunk' }
    );
    expect(resolved).toBe(true);
    expect(result).toBe('late');
  });
});

describe('isChunkLoadError', () => {
  it('recognises our own error', () => {
    expect(isChunkLoadError(new ChunkLoadError('interface', new Error('x')))).toBe(true);
  });

  it("recognises each browser's native wording", () => {
    // A chunk can fail before `importChunk` is reached — React re-throws the
    // raw rejection from `lazy()` when the factory itself is not wrapped, and a
    // service worker can reject the fetch (SC-62). Each engine words it
    // differently and the boundary has to catch all three.
    const natives = [
      'Failed to fetch dynamically imported module: https://app.scani.xyz/assets/V3App.js', // Chrome
      'error loading dynamically imported module', // Firefox
      'Importing a module script failed.', // Safari
    ];
    for (const message of natives) {
      expect(isChunkLoadError(new Error(message))).toBe(true);
    }
  });

  it('does not claim a real crash is a network problem', () => {
    // The boundary re-throws anything this rejects, so a false positive here
    // would quietly swallow genuine bugs behind a "check your connection".
    expect(isChunkLoadError(new TypeError('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError('some string')).toBe(false);
  });
});

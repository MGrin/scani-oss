import { describe, expect, it } from 'bun:test';
import { ChunkLoadError, importChunk, isChunkLoadError } from '../../src/lib/lazy-chunk';

/**
 * The retry path exists because SC-132 relaxed the top-level-import ban for
 * frontend route splitting, and the condition attached to that relaxation was
 * that **a failed chunk fetch must be handled**. An unhandled rejection inside
 * React's render path is a white screen with no message and no button — the
 * SC-62 shape.
 *
 * So these are tests of the failure, not of the success: what happens on a
 * connection that blinks, and what a reader is told when it does not come back.
 */

const noSleep = async () => {};

describe('importChunk', () => {
  it('re-invokes the factory rather than re-awaiting a rejected promise', async () => {
    // The distinction that matters: a module promise the browser has already
    // rejected stays rejected, so retrying by awaiting it again never issues a
    // second request. Counting calls is what pins that.
    let calls = 0;
    const result = await importChunk(
      async () => {
        calls += 1;
        if (calls < 3) throw new TypeError('Failed to fetch dynamically imported module: /a.js');
        return { value: 'loaded' };
      },
      { chunk: 'test chunk', sleep: noSleep }
    );

    expect(result).toEqual({ value: 'loaded' });
    expect(calls).toBe(3);
  });

  it('does not retry a load that works first time', async () => {
    let calls = 0;
    await importChunk(
      async () => {
        calls += 1;
        return 'ok';
      },
      { chunk: 'test chunk', sleep: noSleep }
    );
    expect(calls).toBe(1);
  });

  it('gives up after the configured attempts and says something a person can read', async () => {
    let calls = 0;
    const failing = importChunk(
      async () => {
        calls += 1;
        throw new TypeError('Failed to fetch dynamically imported module: /Excel-abc123.js');
      },
      { chunk: 'Excel writer', attempts: 3, sleep: noSleep }
    );

    await expect(failing).rejects.toThrow(ChunkLoadError);
    expect(calls).toBe(3);

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

  it('waits longer between each attempt', async () => {
    const waits: number[] = [];
    await importChunk(
      async () => {
        if (waits.length < 2) throw new Error('nope');
        return 'ok';
      },
      {
        chunk: 'test chunk',
        sleep: async (ms) => {
          waits.push(ms);
        },
      }
    );
    expect(waits).toEqual([250, 500]);
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

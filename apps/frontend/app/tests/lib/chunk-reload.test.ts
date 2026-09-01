import { describe, expect, test } from 'bun:test';
import { chunkReloadSpent, loadChunkWithOneReload } from '../../src/lib/chunk-reload';

/**
 * The recovery for a route chunk that will not load (SC-890).
 *
 * These are tests of the failure path, and of the one property that decides
 * whether the failure path is better or worse than no failure path at all:
 * **it reloads once and then stops.** A reload-on-failure with no memory turns
 * an offline phone into a tab that spins forever and never reaches the error
 * card, which is worse than the defect this replaces.
 *
 * What this does NOT test, because no test in this process can: that a second
 * `import()` of a failing URL issues no request. That is a property of the
 * browser's module map, a stub factory issues a fresh call every time by
 * construction, and a test built on one is exactly what let the old three-
 * attempt retry loop look protective for as long as it did. The evidence for
 * the mechanism is on SC-890 and was taken in Chromium, WebKit and Brave.
 */

/** A `sessionStorage` that lives as long as one test — the real one persists
 *  across a reload, which is the property under test, so it cannot be shared
 *  between cases. */
function tabStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage;
}

/** Storage that refuses everything, as Safari does with website data blocked —
 *  and it throws on the property access, not on the call. */
const noStorage = null;

/** The reloading path deliberately never settles, so every case that expects a
 *  reload has to race it rather than await it. */
function settledWithin<T>(promise: Promise<T>, ms = 50): Promise<'pending' | 'settled'> {
  return Promise.race([
    promise.then(
      () => 'settled' as const,
      () => 'settled' as const
    ),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms)),
  ]);
}

const failing = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module'));

describe('loadChunkWithOneReload', () => {
  test('a chunk that arrives is returned, with nothing reloaded', async () => {
    let reloads = 0;
    const value = await loadChunkWithOneReload('interface', async () => 'the module', {
      storage: tabStorage(),
      reload: () => {
        reloads += 1;
      },
      report: () => {},
    });

    expect(value).toBe('the module');
    expect(reloads).toBe(0);
  });

  test('the first failure reloads the document once', async () => {
    let reloads = 0;
    const storage = tabStorage();
    const pending = loadChunkWithOneReload('interface', failing, {
      storage,
      reload: () => {
        reloads += 1;
      },
      report: () => {},
    });

    expect(await settledWithin(pending)).toBe('pending');
    expect(reloads).toBe(1);
    // Written BEFORE navigating. A reload that never comes back must still
    // count as having happened, or the guard cannot hold across it.
    expect(storage.getItem('scani.chunk-reload:interface')).toBe('1');
  });

  test('the failure is reported before the reload destroys the evidence', async () => {
    const reported: string[] = [];
    const pending = loadChunkWithOneReload('interface', failing, {
      storage: tabStorage(),
      reload: () => {},
      report: (error) => reported.push(error.message),
    });

    await settledWithin(pending);
    // The readable sentence, not the native one — `importChunk` has already
    // wrapped it, so this is what a reader would have been shown.
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('interface');
  });

  test('THE GUARD: a failure that survives its own reload does not reload again', async () => {
    // The same tab, the same storage, across what would be a page load. This
    // is the offline phone and the genuinely broken deploy, and it is the case
    // that makes an unguarded reload-on-failure worse than doing nothing.
    const storage = tabStorage();
    let reloads = 0;
    const deps = {
      storage,
      reload: () => {
        reloads += 1;
      },
      report: () => {},
    };

    await settledWithin(loadChunkWithOneReload('interface', failing, deps));
    expect(reloads).toBe(1);

    // Second document, same tab: this one must reject so the boundary above can
    // render the card — which has a Reload button the reader presses knowingly.
    await expect(loadChunkWithOneReload('interface', failing, deps)).rejects.toThrow(
      /Could not load the interface/
    );
    expect(reloads).toBe(1);
  });

  test('a chunk that arrives gives the tab its reload back', async () => {
    // Otherwise this is a one-reload-EVER rule, and an installed PWA holds one
    // tab open across several deploys. Each independent failure deserves its
    // own attempt; only a failure that survives a reload is a loop.
    const storage = tabStorage();
    let reloads = 0;
    const deps = {
      storage,
      reload: () => {
        reloads += 1;
      },
      report: () => {},
    };

    await settledWithin(loadChunkWithOneReload('interface', failing, deps));
    expect(reloads).toBe(1);

    await loadChunkWithOneReload('interface', async () => 'recovered', deps);
    expect(storage.getItem('scani.chunk-reload:interface')).toBeNull();

    await settledWithin(loadChunkWithOneReload('interface', failing, deps));
    expect(reloads).toBe(2);
  });

  test('two different chunks do not spend each other’s reload', async () => {
    const storage = tabStorage();
    const reloaded: number[] = [];
    const deps = { storage, reload: () => reloaded.push(1), report: () => {} };

    await settledWithin(loadChunkWithOneReload('interface', failing, deps));
    await settledWithin(loadChunkWithOneReload('component gallery', failing, deps));
    expect(reloaded).toHaveLength(2);
  });

  test('no storage means no automatic reload at all', async () => {
    // Conservative on purpose: with nowhere to record the attempt there is
    // nothing to stop the loop. The reader still gets the card and its button.
    let reloads = 0;
    await expect(
      loadChunkWithOneReload('interface', failing, {
        storage: noStorage,
        reload: () => {
          reloads += 1;
        },
        report: () => {},
      })
    ).rejects.toThrow(/Could not load the interface/);
    expect(reloads).toBe(0);
  });

  test('storage that throws mid-sequence is treated as no storage', async () => {
    // A quota or security error after the read is the same situation, and the
    // failure must not be toward reloading.
    const hostile = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('QuotaExceededError');
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    } as unknown as Storage;

    let reloads = 0;
    await expect(
      loadChunkWithOneReload('interface', failing, {
        storage: hostile,
        reload: () => {
          reloads += 1;
        },
        report: () => {},
      })
    ).rejects.toThrow(/Could not load the interface/);
    expect(reloads).toBe(0);
  });
});

/**
 * The spinner's `phase` and `failures` are read from this marker, because it is
 * the only thing that survives the document being replaced (SC-840, SC-890).
 * `lazy-route.tsx` seeds `RoutePendingFallback` from it; the rendering half is
 * in `route-pending-fallback.test.tsx`.
 */
describe('chunkReloadSpent — what the route spinner reads', () => {
  test('a fresh tab has spent nothing, so the spinner says loading', () => {
    expect(chunkReloadSpent('interface', tabStorage())).toBe(false);
  });

  test('after a failure it reads spent, so the spinner can say retrying', async () => {
    const storage = tabStorage();
    await settledWithin(
      loadChunkWithOneReload('interface', failing, { storage, reload: () => {}, report: () => {} })
    );
    expect(chunkReloadSpent('interface', storage)).toBe(true);
    // Per-chunk, not per-tab: a second route's spinner must not inherit it.
    expect(chunkReloadSpent('component gallery', storage)).toBe(false);
  });

  test('it reads false again once the chunk arrives', async () => {
    const storage = tabStorage();
    const deps = { storage, reload: () => {}, report: () => {} };
    await settledWithin(loadChunkWithOneReload('interface', failing, deps));
    await loadChunkWithOneReload('interface', async () => 'recovered', deps);
    expect(chunkReloadSpent('interface', storage)).toBe(false);
  });

  test('no storage reads false rather than throwing', () => {
    expect(chunkReloadSpent('interface', noStorage)).toBe(false);
  });
});

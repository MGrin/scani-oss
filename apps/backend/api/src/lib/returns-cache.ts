import {
  RedisReturnsAnswerStore,
  type ReturnsAnswerStore,
  readReturnsDataVersion,
  returnsDataKey,
  returnsLatestKey,
} from '@scani/domain/services';
import { LruCache } from './lru-cache';

// The key moves with the data version and the UTC day, which is everything the
// answer reads: inside a day `now` only values today's flows, as the rollup
// that set the version did. Ten minutes made every Home load after a gap cold,
// 4.7-8.9 s on production (SC-1745); a day bounds only memory, with the LRU.
const RETURNS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const runs = new LruCache<string, Promise<unknown>>({
  maxEntries: 500,
  ttlMs: RETURNS_CACHE_TTL_MS,
});

type Observe = (o: { hit: boolean; shared?: boolean; stale?: boolean; versionMs: number }) => void;

interface RunKeys {
  key: string;
  dataKey: string;
  versionMs: number;
}

async function runKeys(
  requestKey: string,
  userId: string,
  readVersion: (userId: string) => Promise<string>,
  today: string
): Promise<RunKeys> {
  const started = performance.now();
  const version = await readVersion(userId);
  const versionMs = Math.round(performance.now() - started);
  const dataKey = returnsDataKey(userId, version, today);
  return { key: `${requestKey}:${dataKey}`, dataKey, versionMs };
}

function runUnder<T>(
  requestKey: string,
  { key, dataKey, versionMs }: RunKeys,
  compute: (dataKey: string) => Promise<T>,
  store: ReturnsAnswerStore,
  observe?: Observe
): Promise<T> {
  const cached = runs.get(key) as Promise<T> | undefined;
  if (cached) {
    observe?.({ hit: true, versionMs });
    return cached;
  }

  const run = (async () => {
    const stored = (await store.get(key)) as T | undefined;
    observe?.({
      hit: stored !== undefined,
      ...(stored !== undefined && { shared: true }),
      versionMs,
    });
    if (stored !== undefined) return stored;
    const computed = await compute(dataKey);
    void store.set(key, computed as never);
    void store.set(returnsLatestKey(requestKey), computed as never);
    return computed;
  })();
  runs.set(key, run);
  // A failed run must not be served to the next caller for the rest of the day.
  run.catch(() => runs.delete(key));
  return run;
}

export async function sharedReturnsRun<T>(
  requestKey: string,
  userId: string,
  /**
   * Gets the user's data key, `user:day:version`: the windows a Home load asks
   * for share their loads under it, and a write changes it (SC-1671).
   */
  compute: (dataKey: string) => Promise<T>,
  readVersion: (userId: string) => Promise<string> = readReturnsDataVersion,
  today: string = new Date().toISOString().slice(0, 10),
  /**
   * The version read is the call's first query, so its time is what a cold
   * database adds; a hit pays nothing else (SC-1745). `shared` marks a hit
   * served from the store rather than from this process.
   */
  observe?: Observe,
  /**
   * Answers every API machine and the worker share (SC-1745): the worker
   * fills it for Home after the writes that move the version.
   */
  store: ReturnsAnswerStore = new RedisReturnsAnswerStore()
): Promise<T> {
  const keys = await runKeys(requestKey, userId, readVersion, today);
  return runUnder(requestKey, keys, compute, store, observe);
}

/**
 * The answer for the current data if this process or the store has it;
 * otherwise the request's last answer at once, `stale`, while the current one
 * is computed for the next read (SC-1745). A write moved the version and the
 * next Home read waited ~3 s on production before the worker's precompute could
 * land. Only for a reader that refetches a stale answer: nothing may be
 * computed FROM one, which is why the comparison keeps `sharedReturnsRun`.
 */
export async function latestOrSharedReturnsRun<T>(
  requestKey: string,
  userId: string,
  compute: (dataKey: string) => Promise<T>,
  {
    readVersion = readReturnsDataVersion,
    today = new Date().toISOString().slice(0, 10),
    observe,
    store = new RedisReturnsAnswerStore(),
  }: {
    readVersion?: (userId: string) => Promise<string>;
    today?: string;
    observe?: Observe;
    store?: ReturnsAnswerStore;
  } = {}
): Promise<{ value: T; stale: boolean }> {
  const keys = await runKeys(requestKey, userId, readVersion, today);
  if (!runs.get(keys.key) && (await store.get(keys.key)) === undefined) {
    const latest = (await store.get(returnsLatestKey(requestKey))) as T | undefined;
    if (latest !== undefined) {
      observe?.({ hit: false, stale: true, versionMs: keys.versionMs });
      runUnder(requestKey, keys, compute, store).catch(() => {});
      return { value: latest, stale: true };
    }
  }
  return { value: await runUnder(requestKey, keys, compute, store, observe), stale: false };
}

/** Test-only: forget every shared run. Not exported from package barrels. */
export function _resetReturnsCache(): void {
  runs.clear();
}

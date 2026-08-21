import { createHash } from 'node:crypto';

/**
 * Determinism primitives for the demo dataset.
 *
 * The dataset's contract is that two runs produce byte-identical figures, so
 * every value in it has to come from a pure function of the seed. Two things
 * follow, and both are constraints on *how* the arithmetic is written rather
 * than on what it computes:
 *
 * - **Ids are hashed, not generated.** `defaultRandom()` on every primary key
 *   would give a dataset whose figures matched and whose rows did not, which
 *   makes a diff between two runs unreadable and a link to a detail page
 *   unstable across resets.
 * - **Only `+ - * /` and `Math.imul`.** IEEE 754 pins those exactly.
 *   `Math.exp` and `Math.pow` are explicitly allowed to differ by
 *   implementation, so a compounding drift written as
 *   `start * Math.pow(1 + r, day)` is reproducible on Bun today and not
 *   guaranteed to be on anything else. Every series below compounds by
 *   repeated multiplication instead.
 */

/** Bumped when a change to these primitives would move existing figures. */
const UUID_NAMESPACE = 'scani-demo-dataset/v1';

function digest(parts: readonly string[]): Buffer {
  return createHash('sha256')
    .update([UUID_NAMESPACE, ...parts].join('/'))
    .digest();
}

/**
 * A stable RFC-4122-shaped id for a logical key — `demoUuid('holding',
 * 'ibkr', 'VOO')` is the same uuid on every machine and every run.
 *
 * Version and variant bits are forced so Postgres and anything reading the
 * value sees a well-formed v4 rather than a 32-character hash that happens to
 * fit. It is not a v4 in any meaningful sense — nothing about it is random —
 * but a uuid column has no way to say "derived", and lying in the shape is
 * cheaper than a text primary key.
 */
export function demoUuid(...parts: readonly string[]): string {
  const bytes = Uint8Array.from(digest(parts).subarray(0, 16));
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * mulberry32 seeded from the same hash. Returns values in [0, 1).
 *
 * Chosen over anything grander because its whole state is one uint32 and its
 * arithmetic is `Math.imul`, `>>>`, `^` and one division by 2 ** 32 — every
 * step exact, so the sequence is a property of the seed rather than of the
 * engine running it.
 */
export function createRng(...parts: readonly string[]): () => number {
  let state = digest(parts).readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface WalkOptions {
  /** Value on day 0. */
  readonly start: number;
  readonly days: number;
  /** Fraction the trend line grows over the whole window, e.g. `0.14`. */
  readonly totalDrift: number;
  /** Max single-day deviation, as a fraction. `0` gives a straight line. */
  readonly volatility: number;
  /**
   * How hard each day is pulled back toward the trend, 0..1. Without it a walk
   * wanders off and the asset stops looking like the one it is labelled as;
   * with it at 1 the walk *is* the trend.
   */
  readonly reversion?: number;
}

/**
 * A mean-reverting random walk — the shape a price series has to have to
 * survive being looked at.
 *
 * A sine wave was tried first and photographs as a textbook wave (SC-82); a
 * pure random walk drifts far enough over 18 months that an asset ends at a
 * price nobody would believe. This is a walk pulled toward a straight trend
 * line, which is neither.
 */
export function seededWalk(seed: readonly string[], options: WalkOptions): number[] {
  const { start, days, totalDrift, volatility } = options;
  const reversion = options.reversion ?? 0.05;
  const rng = createRng(...seed);
  // Compounded daily rather than `Math.pow`-ed — see the note at the top.
  const dailyGrowth = days > 1 ? 1 + totalDrift / (days - 1) : 1;

  const series: number[] = [];
  let trend = start;
  let level = start;
  for (let day = 0; day < days; day++) {
    if (day > 0) {
      trend = trend * dailyGrowth;
      const shock = (rng() * 2 - 1) * volatility;
      level = level * (1 + shock);
      level = level + (trend - level) * reversion;
    }
    series.push(level);
  }
  return series;
}

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` for a UTC instant. */
export function isoDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export function parseDay(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

export function addDays(day: string, count: number): string {
  return isoDay(new Date(parseDay(day).getTime() + count * MS_PER_DAY));
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / MS_PER_DAY);
}

/**
 * A fixed instant inside a day, for `occurred_at` / `observed_at`.
 *
 * Every event in the dataset is stamped at an explicit hour for the same
 * reason the dates are fixed: midnight UTC is the previous day in half the
 * world, and an event that lands on a different date depending on where the
 * reader sits is not deterministic in the sense that matters.
 */
export function atHour(day: string, hour: number, minute = 0): Date {
  return new Date(parseDay(day).getTime() + hour * 3_600_000 + minute * 60_000);
}

/** Adds calendar months, clamping to the last day of a shorter month. */
export function addMonths(day: string, count: number): string {
  const at = parseDay(day);
  const targetMonth = at.getUTCMonth() + count;
  const lastDayOfTarget = new Date(Date.UTC(at.getUTCFullYear(), targetMonth + 1, 0)).getUTCDate();
  return isoDay(
    new Date(Date.UTC(at.getUTCFullYear(), targetMonth, Math.min(at.getUTCDate(), lastDayOfTarget)))
  );
}

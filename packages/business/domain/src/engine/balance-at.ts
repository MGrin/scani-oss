import { Decimal } from '@scani/shared';
import { compareText } from './order';
import {
  AUTHORITIES,
  type BalanceAt,
  type BalanceMethod,
  type Entry,
  type HoldingEvidence,
  type Observation,
} from './types';

interface AnchorWindow {
  from: Date;
  anchor: Observation;
}

interface InstantWinner {
  anchor: Observation;
  inheritsWindow: boolean;
}

export function balanceAt(evidence: HoldingEvidence, at: Date): BalanceAt {
  if (at < evidence.startsAt) return { status: 'absent' };

  const windows = anchorWindows(evidence);
  const first = windows[0];
  if (first === undefined) {
    const applied = evidence.entries.filter((e) => e.at >= evidence.startsAt && e.at <= at);
    return derived(total(applied), 'no-anchor', null, applied.length);
  }

  const current = lastWhere(windows, (w) => w.from <= at);
  if (current === undefined) {
    // The first window's value at its own start, so the balance cannot jump where it begins.
    if (evidence.kind === 'snapshot') {
      return walkBack(evidence.entries, first.anchor, first.from, 'first-snapshot');
    }
    return walkBack(evidence.entries, first.anchor, at, 'walk-back');
  }

  if (at >= current.anchor.at) {
    const applied = entriesIn(evidence.entries, current.anchor.at, at);
    return derived(
      new Decimal(current.anchor.amount).plus(total(applied)),
      'forward',
      current.anchor,
      applied.length
    );
  }
  return walkBack(evidence.entries, current.anchor, at, 'walk-back');
}

/** Disjoint closed spans of time, ascending: `starts[i]` to `ends[i]`, in epoch milliseconds. */
interface Spans {
  starts: number[];
  ends: number[];
}

/**
 * The D7 merge: on a feed holding a snapshot-role value anchors only where no
 * balance-carrying window covers it, and a window carries balances only through
 * a checkpoint of its own input inside it. Non-candidates are removed before any
 * window is built, so they can neither open nor take one over.
 */
function anchorCandidates(evidence: HoldingEvidence): Observation[] {
  const { kind, observations } = evidence;
  if (kind === 'snapshot') return observations.filter((o) => o.role === 'snapshot');
  const carrying = carryingSpans(evidence);
  return observations.filter(
    (o) => o.role === 'checkpoint' || (o.role === 'snapshot' && !covers(carrying, o.at))
  );
}

function covers(spans: Spans, at: Date): boolean {
  const instant = at.getTime();
  const end = spans.ends[lastAtOrBefore(spans.starts, instant)];
  return end !== undefined && instant <= end;
}

/**
 * The windows that carry balances, merged wherever they overlap. A feed adds a
 * window per fetch, by the thousand; merged, they answer a value with one
 * search where the windows themselves would each have to be asked.
 *
 * Instants are epoch numbers throughout: the searches compare them, and
 * comparing Dates costs ten times as much. Nothing outlives the call, because
 * the engine keeps no state.
 */
function carryingSpans({ observations, windows }: HoldingEvidence): Spans {
  const checkpoints = checkpointInstants(observations);
  const carrying: { from: number; to: number }[] = [];
  for (const window of windows) {
    const from = window.from === null ? Number.NEGATIVE_INFINITY : window.from.getTime();
    const to = window.to.getTime();
    const instants = checkpoints.get(window.inputId) ?? [];
    // The last checkpoint at or before the end decides it: if that one is before the start, so is every earlier one.
    const latest = instants[lastAtOrBefore(instants, to)];
    if (latest !== undefined && from <= latest) carrying.push({ from, to });
  }
  // Not a subtraction: two open starts are both -Infinity, and their difference is NaN.
  carrying.sort((a, b) => Number(a.from > b.from) - Number(a.from < b.from));

  const spans: Spans = { starts: [], ends: [] };
  for (const { from, to } of carrying) {
    const last = spans.ends.length - 1;
    const reach = spans.ends[last];
    if (reach !== undefined && from <= reach) {
      spans.ends[last] = Math.max(reach, to);
    } else {
      spans.starts.push(from);
      spans.ends.push(to);
    }
  }
  return spans;
}

/**
 * Each input's checkpoint instants, ascending. An invalid date lies inside no
 * window, and one left in the list would hide the input's other checkpoints:
 * it cannot be sorted or searched past.
 */
function checkpointInstants(observations: readonly Observation[]): Map<string, number[]> {
  const byInput = new Map<string, number[]>();
  for (const { role, inputId, at } of observations) {
    const instant = at.getTime();
    if (role !== 'checkpoint' || inputId === null || Number.isNaN(instant)) continue;
    const instants = byInput.get(inputId);
    if (instants === undefined) byInput.set(inputId, [instant]);
    else instants.push(instant);
  }
  for (const instants of byInput.values()) instants.sort((a, b) => a - b);
  return byInput;
}

/** The index of the last number at or before `limit` in an ascending list, or -1 when there is none. */
function lastAtOrBefore(ascending: readonly number[], limit: number): number {
  let low = 0;
  let high = ascending.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((ascending[middle] as number) <= limit) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

/**
 * A correction takes over the window of the value it corrects (or one from
 * `startsAt` when there is none), so a chain of corrections all inherit the
 * first window. Superseded anchors still shape the windows a later correction
 * inherits, and are dropped only after. A checkpoint's window is never taken
 * over: checkpoints are the truth (D3), so a correction after one opens its own.
 */
function anchorWindows(evidence: HoldingEvidence): AnchorWindow[] {
  const windows: AnchorWindow[] = [];
  const winners = winnerPerInstant(anchorCandidates(evidence));
  for (const { anchor, inheritsWindow } of winners) {
    const previous = windows.at(-1);
    if (inheritsWindow && previous?.anchor.role !== 'checkpoint') {
      windows.pop();
      windows.push({ from: previous?.from ?? evidence.startsAt, anchor });
    } else {
      windows.push({ from: anchor.at, anchor });
    }
  }
  return windows.filter((w) => w.anchor.supersededAt === null);
}

/**
 * A correction that beats superseded rivals at its own instant corrects them,
 * and through them the first value recorded there. Its window opens at the
 * instant when any of them is a plain value, and is inherited only when every
 * one is itself a correction.
 */
function winnerPerInstant(candidates: readonly Observation[]): InstantWinner[] {
  const ordered = [...candidates].sort(
    (a, b) => a.at.getTime() - b.at.getTime() || precedence(a, b)
  );
  const winners: InstantWinner[] = [];
  for (const candidate of ordered) {
    const winner = winners.at(-1);
    if (winner?.anchor.at.getTime() !== candidate.at.getTime()) {
      winners.push({ anchor: candidate, inheritsWindow: isCorrection(candidate) });
    } else if (candidate.supersededAt !== null && !isCorrection(candidate)) {
      winner.inheritsWindow = false;
    }
  }
  return winners;
}

/** A cause means something only on a snapshot-role row; elsewhere it is read as absent. */
function isCorrection(observation: Observation): boolean {
  return observation.role === 'snapshot' && observation.cause === 'correction';
}

function precedence(a: Observation, b: Observation): number {
  return (
    Number(a.supersededAt !== null) - Number(b.supersededAt !== null) ||
    AUTHORITIES.indexOf(a.authority) - AUTHORITIES.indexOf(b.authority) ||
    b.recordedAt.getTime() - a.recordedAt.getTime() ||
    compareText(b.id, a.id)
  );
}

function walkBack(
  entries: readonly Entry[],
  anchor: Observation,
  at: Date,
  method: BalanceMethod
): BalanceAt {
  const applied = entriesIn(entries, at, anchor.at);
  return derived(new Decimal(anchor.amount).minus(total(applied)), method, anchor, applied.length);
}

function entriesIn(entries: readonly Entry[], after: Date, through: Date): Entry[] {
  return entries.filter((e) => e.at > after && e.at <= through);
}

/** Summed in a fixed order so rounding cannot depend on the order evidence arrived in. */
function total(entries: readonly Entry[]): Decimal {
  return [...entries]
    .sort((a, b) => a.at.getTime() - b.at.getTime() || compareText(a.id, b.id))
    .reduce((sum, e) => sum.plus(e.quantity), new Decimal(0));
}

/** `findLast`, which the frontends' ES2022 type-check of this graph does not know. */
function lastWhere<T>(items: readonly T[], matches: (item: T) => boolean): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i] as T;
    if (matches(item)) return item;
  }
  return undefined;
}

function derived(
  balance: Decimal,
  method: BalanceMethod,
  anchor: Observation | null,
  entriesApplied: number
): BalanceAt {
  return {
    status: 'derived',
    balance,
    method,
    anchorId: anchor?.id ?? null,
    anchorAt: anchor?.at ?? null,
    entriesApplied,
  };
}

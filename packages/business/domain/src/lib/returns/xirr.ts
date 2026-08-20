/**
 * XIRR — the money-weighted return, solved by bracketed bisection with a
 * Newton polish (SC-457).
 *
 * ## What it answers, and why it is not TWR
 *
 * TWR strips the timing of contributions out; XIRR puts it back in. It is the
 * constant annual rate at which every cashflow, discounted from its own date,
 * sums to zero — the return the *investor* actually earned given when they put
 * money in. A portfolio can have a fine TWR and a poor XIRR because the owner
 * bought the top. Both are true; they answer different questions, which is why
 * this ticket ships both.
 *
 * ## The solver, and what it refuses to do
 *
 * A root-finder that returns a number no matter what is the failure mode here:
 * an XIRR of 0.0231 carries no mark saying it came from a diverged Newton step,
 * and nobody reading a percentage can tell. So:
 *
 * 1. **Bracket first.** The NPV is evaluated across a fixed ladder of rates
 *    from just above -100% to 100,000,000%. A sign change between two rungs
 *    PROVES a root lies between them (NPV is continuous on `r > -1`). No
 *    bracket, no answer — `status: 'not-converged'`, never a guess.
 * 2. **Bisect.** Guaranteed to converge, cannot leave the bracket, cannot
 *    diverge. 200 halvings take the interval below double precision.
 * 3. **Polish with Newton**, and accept the polished root ONLY if it stays
 *    inside the bracket and strictly reduces `|NPV|`. Newton is the fast,
 *    conventional choice and also the one that walks off to infinity on a
 *    flat derivative; gating it on the bracket keeps the speed and drops the
 *    failure.
 *
 * ## What it returns when it cannot answer
 *
 * A discriminated union, never a sentinel number. `status: 'undefined'` for a
 * question with no answer (all cashflows one sign — money that only ever went
 * in has no rate of return), `status: 'not-converged'` for one the solver
 * could not reach. Neither carries a `rate` field at all, so a caller cannot
 * read one by accident.
 *
 * ## Multiple roots
 *
 * By Descartes' rule of signs, a cashflow sequence with at most one sign change
 * has exactly one IRR. More than one sign change — deposits, then withdrawals,
 * then deposits again — admits several, and the one returned is whichever the
 * bracket ladder found first. That is reported as `uniqueRoot: false` rather
 * than hidden: the number is still the standard spreadsheet answer (Excel's
 * XIRR has the same property and says nothing), and a reader who is told can
 * discount it.
 *
 * ## Precision
 *
 * The solver works in IEEE doubles, not `Decimal`. Discounting needs
 * `(1+r)^(days/365)` with a fractional exponent on every flow on every
 * iteration; a rate is reported to at most four decimal places, and double
 * precision is eleven orders of magnitude finer than that. The amounts arrive
 * as `Decimal` and are converted at this boundary, which is the only place
 * rounding enters.
 */

/** One cashflow from the INVESTOR's point of view: negative = money in. */
export interface Cashflow {
  at: Date;
  /** Base currency. Negative = paid into the portfolio, positive = received. */
  amount: number;
}

export type XirrResult =
  | {
      status: 'ok';
      /** Annual rate as a fraction: `0.0812` = +8.12%/yr. */
      rate: number;
      method: 'bisection' | 'bisection+newton';
      iterations: number;
      /** False when the sign pattern admits more than one IRR. */
      uniqueRoot: boolean;
    }
  | {
      status: 'undefined';
      reason: 'too-few-flows' | 'no-sign-change' | 'zero-span';
    }
  | {
      /**
       * The NPV holds one sign across the entire rate ladder, so no root
       * exists anywhere this solver can represent one.
       *
       * In practice this is not a solver weakness but a real edge of the
       * domain. A 14% loss measured over ONE DAY implies an annual rate of
       * `0.86^365`, i.e. `1 + r` around `1e-35` — a positive real number, and
       * one that `-1 + 1e-35` cannot hold in a float64. The honest report is
       * that there is no answer here, not a rate of -99.9999% that happens to
       * be representable.
       */
      status: 'not-converged';
      reason: 'no-root-in-domain';
    };

const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS_PER_YEAR = 365;

/**
 * The rate ladder the bracket search walks. Starts a hair above -1 because the
 * NPV has a pole there, and ends far past any real portfolio so a bracket is
 * found for the pathological ones too rather than reported as unsolvable.
 */
const RATE_LADDER: readonly number[] = [
  -0.9999999, -0.999, -0.99, -0.95, -0.9, -0.75, -0.5, -0.25, -0.1, -0.01, 0, 0.01, 0.1, 0.25, 0.5,
  1, 2, 5, 10, 50, 100, 1_000, 10_000, 1_000_000,
];

const MAX_BISECTIONS = 200;
const MAX_NEWTON_STEPS = 20;

/**
 * "Close enough to zero" has to be RELATIVE to the money involved. An absolute
 * 1e-10 is unreachably tight on a portfolio of millions and uselessly loose on
 * one of pennies, and the same constant would then mean two different things
 * on two users' screens.
 */
function npvTolerance(flows: readonly Cashflow[]): number {
  let gross = 0;
  for (const flow of flows) gross += Math.abs(flow.amount);
  return Math.max(1e-12, gross * 1e-12);
}

function npvAt(flows: readonly Cashflow[], originMs: number, rate: number): number {
  const base = 1 + rate;
  let total = 0;
  for (const flow of flows) {
    const years = (flow.at.getTime() - originMs) / (DAY_MS * DAYS_PER_YEAR);
    total += flow.amount / base ** years;
  }
  return total;
}

function npvDerivativeAt(flows: readonly Cashflow[], originMs: number, rate: number): number {
  const base = 1 + rate;
  let total = 0;
  for (const flow of flows) {
    const years = (flow.at.getTime() - originMs) / (DAY_MS * DAYS_PER_YEAR);
    total += (-years * flow.amount) / base ** (years + 1);
  }
  return total;
}

/** Sign changes in the chronological amount sequence, zeros ignored. */
function signChanges(flows: readonly Cashflow[]): number {
  let changes = 0;
  let previous = 0;
  for (const flow of flows) {
    const sign = Math.sign(flow.amount);
    if (sign === 0) continue;
    if (previous !== 0 && sign !== previous) changes += 1;
    previous = sign;
  }
  return changes;
}

/**
 * The constant annual rate that discounts `flows` to a zero net present value.
 *
 * `flows` need not be sorted; they are ordered here, because the sign-change
 * count that decides `uniqueRoot` is a statement about chronological order.
 */
export function xirr(flows: readonly Cashflow[]): XirrResult {
  const ordered = [...flows]
    .filter((flow) => Number.isFinite(flow.amount))
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  if (ordered.length < 2) return { status: 'undefined', reason: 'too-few-flows' };

  const originMs = (ordered[0] as Cashflow).at.getTime();
  const lastMs = (ordered[ordered.length - 1] as Cashflow).at.getTime();
  if (lastMs === originMs) return { status: 'undefined', reason: 'zero-span' };

  const hasPositive = ordered.some((flow) => flow.amount > 0);
  const hasNegative = ordered.some((flow) => flow.amount < 0);
  if (!hasPositive || !hasNegative) return { status: 'undefined', reason: 'no-sign-change' };

  const uniqueRoot = signChanges(ordered) <= 1;
  const tolerance = npvTolerance(ordered);

  // 1 — bracket.
  let lo: number | null = null;
  let hi: number | null = null;
  let npvLo = 0;
  let previousRate = RATE_LADDER[0] as number;
  let previousNpv = npvAt(ordered, originMs, previousRate);
  if (Math.abs(previousNpv) < tolerance) {
    return { status: 'ok', rate: previousRate, method: 'bisection', iterations: 0, uniqueRoot };
  }
  for (let i = 1; i < RATE_LADDER.length; i += 1) {
    const rate = RATE_LADDER[i] as number;
    const npv = npvAt(ordered, originMs, rate);
    if (!Number.isFinite(npv)) {
      previousRate = rate;
      previousNpv = npv;
      continue;
    }
    if (Math.abs(npv) < tolerance) {
      return { status: 'ok', rate, method: 'bisection', iterations: i, uniqueRoot };
    }
    if (Number.isFinite(previousNpv) && Math.sign(npv) !== Math.sign(previousNpv)) {
      lo = previousRate;
      hi = rate;
      npvLo = previousNpv;
      break;
    }
    previousRate = rate;
    previousNpv = npv;
  }

  if (lo === null || hi === null) return { status: 'not-converged', reason: 'no-root-in-domain' };

  // 2 — bisect. The bracket is an invariant: every step keeps a sign change
  // between `lo` and `hi`, so the root can never be lost.
  let iterations = 0;
  let mid = (lo + hi) / 2;
  let npvMid = npvAt(ordered, originMs, mid);
  while (iterations < MAX_BISECTIONS) {
    if (Math.abs(npvMid) < tolerance) break;
    if (hi - lo <= 1e-14 * Math.max(1, Math.abs(lo))) break;
    if (Math.sign(npvMid) === Math.sign(npvLo)) {
      lo = mid;
      npvLo = npvMid;
    } else {
      hi = mid;
    }
    mid = (lo + hi) / 2;
    npvMid = npvAt(ordered, originMs, mid);
    iterations += 1;
  }

  // 3 — Newton polish, accepted only if it stays in the bracket and improves.
  let best = mid;
  let bestNpv = Math.abs(npvMid);
  let method: 'bisection' | 'bisection+newton' = 'bisection';
  let candidate = mid;
  for (let step = 0; step < MAX_NEWTON_STEPS; step += 1) {
    const slope = npvDerivativeAt(ordered, originMs, candidate);
    if (!Number.isFinite(slope) || slope === 0) break;
    const next = candidate - npvAt(ordered, originMs, candidate) / slope;
    if (!Number.isFinite(next) || next <= lo || next >= hi) break;
    const nextNpv = Math.abs(npvAt(ordered, originMs, next));
    if (!(nextNpv < bestNpv)) break;
    best = next;
    bestNpv = nextNpv;
    method = 'bisection+newton';
    candidate = next;
    iterations += 1;
  }

  return { status: 'ok', rate: best, method, iterations, uniqueRoot };
}

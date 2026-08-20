import { type PingableRedis, pingWithin } from './ping-within';
import type { RedisReachability } from './redis-reachability';

/**
 * Raises an alert when this process has been stranded on an unreachable Redis
 * long enough that nobody is coming to fix it (SC-327).
 *
 * ## What it is for
 *
 * Redis runs INSIDE the scani-worker Fly machine, so anything that replaces
 * that machine strands every other service's ioredis on a name that no longer
 * resolves, forever (SC-225: no DNS cache to expire, no give-up). SC-321
 * turned the repair into `scripts/recycle-redis-consumers.sh` and bound it to
 * the EVENT rather than the deploy — but a repair still needs somebody to run
 * it, and the events that produce this have no human in the loop: an OOM
 * restart, a crash loop, a Fly-initiated host migration. On 2026-08-16
 * production was down ~20 minutes and `/health` answered 200 the whole time,
 * because `/health` is shallow by design — fly.toml gates traffic on it, so it
 * must not depend on Redis.
 *
 * ## Why it runs in-process, in every consumer
 *
 * The obvious alternative is a scheduled probe on the worker that fetches each
 * consumer's `/health/deep`. That is structurally blind to the failure it is
 * meant to catch: `api.scani.xyz` is a PAIR of machines behind a load
 * balancer, so a fetch of the public hostname reaches one of them at random,
 * and the observed failure mode is exactly one machine of the pair stranded
 * while its sibling is fine (SC-294, twice on 2026-08-15). Addressing a
 * specific machine needs `Fly-Force-Instance-Id` and therefore machine ids and
 * a Fly token, neither of which the worker has. A probe with a coin-flip's
 * chance of seeing a half-stranded fleet is another liveness signal that lies,
 * which is the family of mistake this ticket exists to stop making.
 *
 * Every machine watching itself has no such blind spot, costs no HTTP call, no
 * Postgres advisory lock and no Neon wake, and reports the thing itself: *I
 * pinged Redis, it did not answer, and it has not answered for N ms.*
 *
 * ## Why the discriminator is time, and cannot be anything else
 *
 * During a normal worker deploy the consumers ARE briefly stranded, and
 * SC-321's script recycles them within a minute or two. An alert that cannot
 * tell that apart from an abandoned strand gets muted inside a week.
 *
 * A stranded process has no coordination channel left. Every piece of shared
 * state in this system — the queue, the locks, the rate-limit buckets, the
 * realtime bus — lives behind the very Redis it cannot reach, so it cannot be
 * told "a deploy is in progress"; and it holds no Fly credentials with which
 * to ask. What remains is the wall clock, and the honest question it can
 * answer: *has this outlasted the window in which a repair would have
 * arrived?* Both repair paths end by RESTARTING this process, so in the deploy
 * case this watchdog does not stay quiet, it ceases to exist — and the fresh
 * process starts from a clean tracker.
 *
 * {@link REDIS_STRAND_GRACE_MS} justifies the number.
 *
 * ## Why the tracker alone is not enough to alert on
 *
 * The reachability tracker latches on `error` and clears only on `ready`, and
 * ioredis emits `error` for conditions that do not close the socket — those
 * are never followed by a `ready`, so a latched tracker can sit "unreachable"
 * against a perfectly healthy Redis. `/health/deep` already refuses to trust
 * it alone for that reason. So does this: the tracker decides *for how long*,
 * a bounded PING decides *whether*, and no alert is raised unless the PING
 * itself fails.
 */

/**
 * How long a strand must persist before it is somebody's problem.
 *
 * It is the repair path's own deadline, not a guess. `scripts/recycle-redis-
 * consumers.sh` is the only thing that fixes this, and the "Recycle Redis
 * consumers" step in `.github/workflows/deploy-fly.yaml` runs it under
 * `timeout-minutes: 10` — so ten minutes is precisely the point at which the
 * deploy path itself declares the repair failed. Before that a repair may
 * still be in flight; after it, by CI's own definition, nobody is coming.
 *
 * The arithmetic agrees. Worst case per consumer machine is a restart, a
 * verify loop of 6 × (curl `--max-time 10` + 5s sleep) ≈ 90s, at most one more
 * restart and a `smoke`, run over `scani-backend`'s pair and
 * `scani-data-provider` in sequence — comfortably inside ten minutes, and
 * comfortably below the 17-21 minute unattended outage of 2026-08-16 that this
 * alert exists to have caught. Both bounds are read off the script, the
 * workflow and the incident record; neither has been measured against a live
 * deploy from here.
 *
 * The tie at the boundary is deliberate and one-sided: a recycle that only
 * finishes at 9m50s can page once, which costs a glance at a deploy that was
 * already pathologically slow. Raising the grace above CI's timeout would
 * instead mean a window in which the repair has provably given up and the
 * alert has not yet spoken.
 *
 * The failure mode of too LOW is an alert during every deploy, which ends with
 * the alert muted and the real one missed. The failure mode of too HIGH is
 * minutes of an outage that was going to last until a human noticed anyway.
 * They are not symmetric, so this errs high.
 */
export const REDIS_STRAND_GRACE_MS = 10 * 60 * 1000;

/** How often the watchdog looks at the tracker. Costs nothing when healthy. */
const DEFAULT_TICK_MS = 30_000;

/**
 * How long between repeat alerts while a strand continues.
 *
 * One event per outage would be correct if alerts were never missed. They are,
 * so the signal repeats — but at a cadence that stays readable rather than at
 * ioredis's 2-second error cadence, which is how the original symptom came to
 * be scrolled past for three hours.
 */
const DEFAULT_REPEAT_MS = 15 * 60 * 1000;

/** Matches `/health/deep`'s bound: one full ioredis retry interval. */
const DEFAULT_PING_TIMEOUT_MS = 2_000;

export interface StrandReport {
  readonly label: string;
  /** How long this run of failures has lasted, per the reachability tracker. */
  readonly unreachableForMs: number;
  readonly consecutiveErrors: number;
  /**
   * True when ioredis is failing to RESOLVE the host rather than to connect
   * to it. This is the one that will not self-heal: the process cannot fix a
   * resolver, so the machine has to be replaced.
   */
  readonly nameResolutionFailure: boolean;
  readonly lastError: string;
  /** Why the confirming PING failed — the evidence that this is real now. */
  readonly pingError: string;
  /** 0 for the first alert of an outage, incrementing for each repeat. */
  readonly repeat: number;
  /** The command that actually repairs this, for the process that raised it. */
  readonly remedy: string;
}

/**
 * Right for the api and the data-provider, whose Redis lives in a machine
 * somebody else replaced. Wrong for the worker, which IS that machine — see
 * its own `remedy` at the call site.
 */
const DEFAULT_REMEDY = 'run scripts/recycle-redis-consumers.sh';

/** The slice of the reachability observer this needs. */
export interface ReachabilitySource {
  current(now?: Date): RedisReachability;
}

export interface RedisStrandWatchdogOptions {
  reachability: ReachabilitySource;
  redis: PingableRedis;
  /**
   * Called once the strand is confirmed. Kept as a callback so this package
   * stays dependency-free and so the test can assert on the alert without a
   * Sentry client; the apps hand it `captureException`.
   */
  onStranded: (report: StrandReport) => void;
  label?: string;
  /** Overrides {@link DEFAULT_REMEDY} where the repair is a different one. */
  remedy?: string;
  graceMs?: number;
  tickMs?: number;
  repeatMs?: number;
  pingTimeoutMs?: number;
  /** Injectable seams — tests drive `check()` on a fake clock. */
  now?: () => Date;
  setIntervalFn?: (fn: () => void, ms: number) => { unref?: () => void };
}

export interface RedisStrandWatchdog {
  /**
   * Evaluate once. The interval calls this; tests call it directly so no
   * assertion depends on real time passing.
   */
  check(): Promise<void>;
}

/**
 * The message a human reads at 3am. States the fact, the duration, and the
 * command that repairs it — a page that requires the reader to already know
 * the runbook is a page that costs twenty minutes finding the runbook.
 */
export function strandedRedisError(report: StrandReport): Error {
  const kind = report.nameResolutionFailure
    ? 'host does not resolve from this machine (will not self-heal — the machine must be replaced)'
    : 'connection refused or timing out';
  const err = new Error(
    `Redis stranded: ${report.label} unreachable for ${Math.round(report.unreachableForMs / 1000)}s ` +
      `(${report.consecutiveErrors} attempts, PING: ${report.pingError}) — ${kind}. ` +
      `No deploy is repairing this; ${report.remedy}`
  );
  err.name = 'RedisStrandedError';
  return err;
}

export function startRedisStrandWatchdog(options: RedisStrandWatchdogOptions): RedisStrandWatchdog {
  const {
    reachability,
    redis,
    onStranded,
    label = 'redis',
    remedy = DEFAULT_REMEDY,
    graceMs = REDIS_STRAND_GRACE_MS,
    tickMs = DEFAULT_TICK_MS,
    repeatMs = DEFAULT_REPEAT_MS,
    pingTimeoutMs = DEFAULT_PING_TIMEOUT_MS,
    now = () => new Date(),
    setIntervalFn = (fn, ms) => setInterval(fn, ms),
  } = options;

  let lastAlertAt: number | null = null;
  let repeat = 0;
  let inFlight = false;

  const emit = (
    state: Extract<RedisReachability, { state: 'unreachable' }>,
    pingError: string,
    at: Date
  ): void => {
    onStranded({
      label,
      unreachableForMs: state.unreachableForMs,
      consecutiveErrors: state.consecutiveErrors,
      nameResolutionFailure: state.nameResolutionFailure,
      lastError: state.lastError,
      pingError,
      repeat,
      remedy,
    });
    lastAlertAt = at.getTime();
    repeat += 1;
  };

  const check = async (): Promise<void> => {
    const at = now();
    const state = reachability.current(at);

    if (state.state === 'ok') {
      // Recovered — whoever was coming came, or ioredis reconnected. Re-arm
      // so a SECOND outage later in this process's life alerts again.
      lastAlertAt = null;
      repeat = 0;
      return;
    }

    if (state.unreachableForMs < graceMs) return;
    if (lastAlertAt !== null && at.getTime() - lastAlertAt < repeatMs) return;
    // The PING below is bounded, but a slow one must not stack: ticks are
    // faster than the repeat cadence and an overlapping check would report the
    // same outage twice from one machine.
    if (inFlight) return;

    inFlight = true;
    try {
      const reply = await pingWithin(redis, pingTimeoutMs);
      if (reply === 'PONG') {
        // The tracker is latched on an `error` that never closed the socket
        // and so was never followed by a `ready`. Redis is fine. This branch
        // is the entire reason the alert pings instead of trusting the
        // tracker — without it the watchdog pages for a healthy Redis and is
        // muted, which is worse than not existing.
        return;
      }
      emit(state, `unexpected reply ${reply}`, at);
    } catch (err) {
      emit(state, err instanceof Error ? err.message : String(err), at);
    } finally {
      inFlight = false;
    }
  };

  // `unref` so a watchdog can never be the reason a process refuses to exit;
  // shutdown paths in these apps close Redis and expect the loop to drain.
  const handle = setIntervalFn(() => void check(), tickMs);
  handle.unref?.();

  return { check };
}

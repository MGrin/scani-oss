import { type ProbeResult, probeDataProvider } from './health-probe';

/**
 * Background data-provider reachability monitor.
 *
 * Both the api and the worker ran their own copy of this loop and the two
 * had already drifted (only the api carried a "report once" latch). It
 * lives here, next to the probe it drives, so there is one behaviour to
 * reason about and one thing to test.
 *
 * The rule it exists to enforce: **do not alert on a single failed cycle.**
 * Sentry SCANI-BACKEND-7 was three `data-provider re-probe failed: The
 * operation was aborted.` errors, and all three landed inside a deploy
 * window — the api on release N probing while release N+1 replaced the
 * data-provider machine. `apps/backend/data-provider/fly.toml` runs
 * `min_machines_running = max_machines_running = 1` with a rolling
 * strategy, so the only machine goes down on every deploy; the file's own
 * comment accepts that ("Deploys briefly 5xx backend/worker outbound calls
 * during the cutover"). The loop was paging us about a documented,
 * self-healing, designed-in event.
 *
 * The probe budget is not the problem and is deliberately not changed:
 * `/health` is a static object literal with no I/O, and the same Sentry
 * events show sibling calls to the data-provider returning in 14ms. Three
 * 3s aborts means the machine genuinely was not serving. The detection is
 * correct — reporting one missed cycle as an error is what is wrong, since
 * one missed cycle is by construction indistinguishable from a deploy.
 *
 * So `onOutage` fires only once the data-provider has been unreachable for
 * `failuresBeforeAlert` consecutive cycles. That changes the claim being
 * made from "a probe missed" to "unreachable for N minutes", which is
 * worth an error. Every failed cycle still calls `onCycleFailed`, so a
 * blip is never invisible — it is just a log line instead of a page.
 */

export interface OutageInfo {
  url?: string;
  status?: number;
  error?: string;
  /** Consecutive failed cycles at the moment of the callback. */
  consecutiveFailures: number;
}

export interface RecoveryInfo {
  url?: string;
  /** How many consecutive cycles had failed before this one succeeded. */
  failedCycles: number;
  /** Whether `onOutage` had already fired for the episode now ending. */
  wasReported: boolean;
}

export interface DataProviderMonitorOptions {
  /**
   * Consecutive failed cycles before an outage is reported. With the
   * default 60s interval, 5 means "unreachable for ~5 minutes" — far
   * longer than a single-machine deploy cutover, still prompt for a real
   * outage. Nothing user-facing waits on this: the reachability flag is
   * advisory, and cloud calls surface their own errors regardless.
   */
  failuresBeforeAlert?: number;
  intervalMs?: number;
  /** Injectable for tests; defaults to the real HTTP probe. */
  probe?: () => Promise<ProbeResult>;
  /** Seed from the boot probe so a boot-time outage counts as cycle one. */
  initiallyReachable?: boolean;
  /** Fires once per sustained outage, at the threshold. */
  onOutage: (info: OutageInfo) => void;
  /** Fires on every failed cycle, including the ones below the threshold. */
  onCycleFailed?: (info: OutageInfo) => void;
  /** Fires when a probe succeeds after any number of failed cycles. */
  onRecovered?: (info: RecoveryInfo) => void;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_FAILURES_BEFORE_ALERT = 5;

export class DataProviderHealthMonitor {
  private consecutiveFailures: number;
  private reported = false;
  private readonly failuresBeforeAlert: number;
  private readonly intervalMs: number;
  private readonly probe: () => Promise<ProbeResult>;
  private readonly opts: DataProviderMonitorOptions;

  constructor(opts: DataProviderMonitorOptions) {
    this.opts = opts;
    this.failuresBeforeAlert = opts.failuresBeforeAlert ?? DEFAULT_FAILURES_BEFORE_ALERT;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.probe = opts.probe ?? probeDataProvider;
    // A boot-time failure is the first cycle of the episode, not a
    // separate class of event — an api that boots while the data-provider
    // is mid-deploy is the same transient seen from a different angle.
    this.consecutiveFailures = opts.initiallyReachable === false ? 1 : 0;
  }

  get reachable(): boolean {
    return this.consecutiveFailures === 0;
  }

  /** One probe cycle. Exposed so tests drive the state machine directly. */
  async tick(): Promise<void> {
    const probe = await this.probe();

    if (probe.ok) {
      if (this.consecutiveFailures > 0) {
        const info: RecoveryInfo = {
          url: probe.url,
          failedCycles: this.consecutiveFailures,
          wasReported: this.reported,
        };
        this.consecutiveFailures = 0;
        // Cleared on recovery, not latched for the process lifetime. The
        // api's old `everReportedDown` never reset, so after one report
        // that process could never report a second, genuine outage.
        this.reported = false;
        this.opts.onRecovered?.(info);
      }
      return;
    }

    this.consecutiveFailures += 1;
    const info: OutageInfo = {
      url: probe.url,
      status: probe.status,
      error: probe.error,
      consecutiveFailures: this.consecutiveFailures,
    };
    this.opts.onCycleFailed?.(info);

    if (!this.reported && this.consecutiveFailures >= this.failuresBeforeAlert) {
      this.reported = true;
      this.opts.onOutage(info);
    }
  }

  /** Starts the interval. Returns a stop function. */
  start(): () => void {
    const timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, this.intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}

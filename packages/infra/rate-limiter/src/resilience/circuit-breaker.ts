// Per-provider failure-tracking circuit breaker. Tracks consecutive
// failures by provider key; opens the circuit after `failureThreshold`
// consecutive failures and short-circuits subsequent calls until
// `cooldownMs` elapses, then admits a single probe call.
//
// Sits in @scani/rate-limiter alongside outflow/inflow rate limiting
// because both are resilience primitives applied at the upstream
// boundary — limiters cap call rate; circuit breakers stop calling
// when the upstream is clearly failing. Sharing one package keeps
// import paths simple and lets future work reuse the same redis
// connection if a distributed circuit breaker is needed.
//
// In-process only (no Redis backing). Per-replica failure counts diverge
// across horizontally-scaled instances — fine for our pricing/integration
// upstreams where the ~5-minute cooldown amortizes the divergence.

interface CircuitState {
  failures: number;
  lastFailure: number;
  isOpen: boolean;
  /** When true, exactly one probe request has been allowed through after cooldown. */
  isProbing: boolean;
}

export class CircuitBreaker {
  private readonly circuits = new Map<string, CircuitState>();

  constructor(
    /** Number of consecutive failures before opening the circuit. */
    private readonly failureThreshold: number = 5,
    /** How long (ms) to keep the circuit open before allowing a probe. */
    private readonly cooldownMs: number = 5 * 60 * 1000
  ) {}

  /** Returns true if the provider is currently available (closed or cooldown elapsed). */
  isAvailable(provider: string): boolean {
    const state = this.circuits.get(provider);
    if (!state?.isOpen) return true;

    if (Date.now() - state.lastFailure >= this.cooldownMs) {
      if (!state.isProbing) {
        state.isProbing = true;
        return true;
      }
      return false;
    }

    return false;
  }

  /** Record a successful call — resets the failure counter. */
  recordSuccess(provider: string): void {
    const state = this.circuits.get(provider);
    if (state) {
      state.failures = 0;
      state.isOpen = false;
      state.isProbing = false;
    }
  }

  /** Record a failed call — may open the circuit. */
  recordFailure(provider: string): void {
    let state = this.circuits.get(provider);
    if (!state) {
      state = { failures: 0, lastFailure: 0, isOpen: false, isProbing: false };
      this.circuits.set(provider, state);
    }

    // If a probe failed, re-open with a fresh cooldown.
    if (state.isProbing) {
      state.isOpen = true;
      state.isProbing = false;
      state.lastFailure = Date.now();
      return;
    }

    state.failures++;
    state.lastFailure = Date.now();

    if (state.failures >= this.failureThreshold) {
      state.isOpen = true;
    }
  }
}

/** Shared circuit breaker for all pricing providers (5 fails / 5min cooldown). */
export const pricingCircuitBreaker = new CircuitBreaker(5, 5 * 60 * 1000);

/**
 * Shared circuit breaker for integration services (exchanges, blockchains).
 *
 * Tighter cooldown than pricing (2min vs 5min) — exchange outages are
 * bursty and we want to bail out faster rather than hammering a failing
 * endpoint through retry + backoff.
 */
export const integrationCircuitBreaker = new CircuitBreaker(5, 2 * 60 * 1000);

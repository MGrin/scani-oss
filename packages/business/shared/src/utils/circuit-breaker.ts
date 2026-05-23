/**
 * Simple circuit breaker for external API providers.
 *
 * Tracks consecutive failures per provider. When failures exceed the threshold,
 * the circuit "opens" and calls are skipped for a cooldown period.
 *
 * States:
 *  - CLOSED  → normal operation, requests go through
 *  - OPEN    → too many failures, requests are short-circuited
 *  - After cooldown, circuit automatically resets to CLOSED (next call is a probe)
 */

interface CircuitState {
  failures: number;
  lastFailure: number;
  isOpen: boolean;
  /** When true, exactly one probe request has been allowed through after cooldown */
  isProbing: boolean;
}

export class CircuitBreaker {
  private readonly circuits = new Map<string, CircuitState>();

  constructor(
    /** Number of consecutive failures before opening the circuit */
    private readonly failureThreshold: number = 5,
    /** How long (ms) to keep the circuit open before allowing a probe */
    private readonly cooldownMs: number = 5 * 60 * 1000
  ) {}

  /** Returns true if the provider is currently available (circuit closed or cooldown elapsed) */
  isAvailable(provider: string): boolean {
    const state = this.circuits.get(provider);
    if (!state?.isOpen) return true;

    // Check if cooldown has elapsed — enter half-open state
    if (Date.now() - state.lastFailure >= this.cooldownMs) {
      if (!state.isProbing) {
        // Allow exactly one probe request through
        state.isProbing = true;
        return true;
      }
      // A probe is already in flight — block until it resolves
      return false;
    }

    return false;
  }

  /** Record a successful call — resets the failure counter */
  recordSuccess(provider: string): void {
    const state = this.circuits.get(provider);
    if (state) {
      state.failures = 0;
      state.isOpen = false;
      state.isProbing = false;
    }
  }

  /** Record a failed call — may open the circuit */
  recordFailure(provider: string): void {
    let state = this.circuits.get(provider);
    if (!state) {
      state = { failures: 0, lastFailure: 0, isOpen: false, isProbing: false };
      this.circuits.set(provider, state);
    }

    // If we were probing and it failed, re-open with fresh cooldown
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

/** Shared circuit breaker for all pricing providers */
export const pricingCircuitBreaker = new CircuitBreaker(5, 5 * 60 * 1000);

/**
 * Shared circuit breaker for integration services (exchanges, blockchains).
 *
 * Opens after 5 consecutive failures per provider and stays open for 2 minutes.
 * Threshold is tighter than the pricing breaker because exchange outages are
 * more bursty and we want to bail out faster rather than hammering a failing
 * endpoint through retry + backoff.
 */
export const integrationCircuitBreaker = new CircuitBreaker(5, 2 * 60 * 1000);

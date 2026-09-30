import type { AIAvailabilityState } from '@scani/providers/core/capabilities';

/**
 * AI is an optional capability: statements, manual entry and every page work
 * without it. So the deep check fails only when nothing is configured, as it
 * did before availability existed, and reports what it last observed beside
 * that. Gating on a rejected key would 503 every deploy smoke from the first
 * revoked-key call onward.
 */
export function aiHealthCheck(availability: { state: AIAvailabilityState }) {
  return availability.state === 'missing'
    ? { ok: false, state: availability.state, error: 'no AI provider configured' }
    : { ok: true, state: availability.state };
}

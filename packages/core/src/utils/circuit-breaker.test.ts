import { describe, expect, it } from 'bun:test';
import { CircuitBreaker } from './circuit-breaker';

describe('CircuitBreaker', () => {
  it('should start with circuit closed (available)', () => {
    const cb = new CircuitBreaker(3, 1000);
    expect(cb.isAvailable('provider')).toBe(true);
  });

  it('should remain available after fewer failures than threshold', () => {
    const cb = new CircuitBreaker(3, 1000);
    cb.recordFailure('provider');
    cb.recordFailure('provider');
    expect(cb.isAvailable('provider')).toBe(true);
  });

  it('should open circuit after reaching failure threshold', () => {
    const cb = new CircuitBreaker(3, 1000);
    cb.recordFailure('provider');
    cb.recordFailure('provider');
    cb.recordFailure('provider');
    expect(cb.isAvailable('provider')).toBe(false);
  });

  it('should reset after a successful call', () => {
    const cb = new CircuitBreaker(3, 1000);
    cb.recordFailure('provider');
    cb.recordFailure('provider');
    cb.recordSuccess('provider');
    cb.recordFailure('provider');
    cb.recordFailure('provider');
    // Only 2 failures after reset, should still be available
    expect(cb.isAvailable('provider')).toBe(true);
  });

  it('should track providers independently', () => {
    const cb = new CircuitBreaker(2, 1000);
    cb.recordFailure('providerA');
    cb.recordFailure('providerA');
    cb.recordFailure('providerB');

    expect(cb.isAvailable('providerA')).toBe(false);
    expect(cb.isAvailable('providerB')).toBe(true);
  });

  it('should recover after cooldown period', () => {
    const cb = new CircuitBreaker(2, 50); // 50ms cooldown
    cb.recordFailure('provider');
    cb.recordFailure('provider');
    expect(cb.isAvailable('provider')).toBe(false);

    // Wait for cooldown
    const start = Date.now();
    while (Date.now() - start < 60) {
      // busy wait
    }
    expect(cb.isAvailable('provider')).toBe(true);
  });

  it('should handle unknown providers as available', () => {
    const cb = new CircuitBreaker(3, 1000);
    expect(cb.isAvailable('never-seen')).toBe(true);
  });

  it('should handle recordSuccess for unknown providers', () => {
    const cb = new CircuitBreaker(3, 1000);
    // Should not throw
    cb.recordSuccess('never-seen');
    expect(cb.isAvailable('never-seen')).toBe(true);
  });
});

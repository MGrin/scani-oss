import { describe, expect, test } from 'bun:test';
import { aiHealthCheck } from '../../src/lib/ai-health';

describe('aiHealthCheck (SC-1397)', () => {
  test('a configured provider keeps the deep check green whatever it last observed', () => {
    for (const state of ['unverified', 'ready', 'rejected', 'transient'] as const) {
      expect(aiHealthCheck({ state })).toEqual({ ok: true, state });
    }
  });

  test('no configured provider is the one AI state that fails the check', () => {
    expect(aiHealthCheck({ state: 'missing' })).toEqual({
      ok: false,
      state: 'missing',
      error: 'no AI provider configured',
    });
  });
});

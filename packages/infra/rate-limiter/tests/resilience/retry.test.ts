import { describe, expect, it } from 'bun:test';
import { defaultIsTransient, withRetry } from '../../src/resilience/retry';

describe('defaultIsTransient', () => {
  it('classifies network errors as transient', () => {
    expect(defaultIsTransient(new Error('socket hang up'))).toBe(true);
    expect(defaultIsTransient(new Error('ECONNRESET'))).toBe(true);
    expect(defaultIsTransient(new Error('fetch failed'))).toBe(true);
    expect(defaultIsTransient(new Error('Request timeout'))).toBe(true);
  });

  it('classifies HTTP 429 / 5xx as transient', () => {
    const err429 = Object.assign(new Error('Too many requests'), { status: 429 });
    const err500 = Object.assign(new Error('Internal'), { status: 500 });
    const err503 = Object.assign(new Error('Unavailable'), { status: 503 });
    expect(defaultIsTransient(err429)).toBe(true);
    expect(defaultIsTransient(err500)).toBe(true);
    expect(defaultIsTransient(err503)).toBe(true);
  });

  it('does not classify 4xx (other than 429) as transient', () => {
    const err400 = Object.assign(new Error('Bad request'), { status: 400 });
    const err401 = Object.assign(new Error('Unauthorized'), { status: 401 });
    expect(defaultIsTransient(err400)).toBe(false);
    expect(defaultIsTransient(err401)).toBe(false);
  });

  it('returns false for non-Error inputs', () => {
    expect(defaultIsTransient('boom')).toBe(false);
    expect(defaultIsTransient({ status: 500 })).toBe(false);
  });
});

describe('withRetry', () => {
  it('returns the resolved value when the first attempt succeeds', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries transient failures up to `attempts`', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('socket hang up');
        return 'eventually ok';
      },
      { attempts: 3, baseDelayMs: 1, maxDelayMs: 5 }
    );
    expect(result).toBe('eventually ok');
    expect(calls).toBe(3);
  });

  it('does not retry non-transient errors', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error('validation failed');
        },
        { attempts: 5, baseDelayMs: 1 }
      )
    ).rejects.toThrow('validation failed');
    expect(calls).toBe(1);
  });

  it('rethrows after exhausting attempts', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error('socket hang up');
        },
        { attempts: 2, baseDelayMs: 1, maxDelayMs: 5 }
      )
    ).rejects.toThrow('socket hang up');
    expect(calls).toBe(2);
  });

  it('honors a custom isTransient classifier', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error('boom');
        },
        { attempts: 3, baseDelayMs: 1, isTransient: () => false }
      )
    ).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });
});

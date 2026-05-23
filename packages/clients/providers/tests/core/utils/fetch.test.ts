import { describe, expect, test } from 'bun:test';
import { fetchWithTimeout } from '../../../src/core/utils/fetch';

describe('fetchWithTimeout', () => {
  test('rejects malformed URL synchronously', async () => {
    await expect(fetchWithTimeout('not-a-url')).rejects.toThrow(/Invalid URL/);
  });

  // We can't easily exercise the retry/backoff path against the global
  // fetch in a unit test without spinning up a server; the per-provider
  // tests using replayHttp from core/testing.ts cover that. Here we just
  // verify the URL pre-validation, which is the synchronous safety net.
});

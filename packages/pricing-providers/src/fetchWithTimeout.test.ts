import { afterEach, describe, expect, it, mock } from 'bun:test';
import { fetchWithTimeout } from './utils';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('fetchWithTimeout', () => {
  it('should return response on success', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response('ok', { status: 200 })));
    const res = await fetchWithTimeout('https://example.com/api', undefined, 5000, 0);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('should throw on invalid URL', async () => {
    expect(fetchWithTimeout('not-a-url', undefined, 5000, 0)).rejects.toThrow('Invalid URL');
  });

  it('should timeout after specified duration', async () => {
    globalThis.fetch = mock(
      () => new Promise((resolve) => setTimeout(() => resolve(new Response('late')), 5000))
    );
    expect(fetchWithTimeout('https://example.com/api', undefined, 50, 0)).rejects.toThrow(
      'timeout'
    );
  });

  it('should retry on 500 server error', async () => {
    let callCount = 0;
    globalThis.fetch = mock(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(new Response('error', { status: 500, statusText: 'Internal' }));
      }
      return Promise.resolve(new Response('ok', { status: 200 }));
    });

    const res = await fetchWithTimeout('https://example.com/api', undefined, 5000, 1);
    expect(res.status).toBe(200);
    expect(callCount).toBe(2);
  });

  it('should retry on 429 rate limit', async () => {
    let callCount = 0;
    globalThis.fetch = mock(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(new Response('rate limited', { status: 429 }));
      }
      return Promise.resolve(new Response('ok', { status: 200 }));
    });

    const res = await fetchWithTimeout('https://example.com/api', undefined, 5000, 1);
    expect(res.status).toBe(200);
    expect(callCount).toBe(2);
  });

  it('should NOT retry on 400 client error', async () => {
    let callCount = 0;
    globalThis.fetch = mock(() => {
      callCount++;
      return Promise.resolve(new Response('bad request', { status: 400 }));
    });

    const res = await fetchWithTimeout('https://example.com/api', undefined, 5000, 2);
    expect(res.status).toBe(400);
    expect(callCount).toBe(1); // No retries for 4xx (except 429)
  });

  it('should retry on network error', async () => {
    let callCount = 0;
    globalThis.fetch = mock(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error('network connection failed'));
      }
      return Promise.resolve(new Response('ok', { status: 200 }));
    });

    const res = await fetchWithTimeout('https://example.com/api', undefined, 5000, 1);
    expect(res.status).toBe(200);
    expect(callCount).toBe(2);
  });

  it('should throw after exhausting retries', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('error', { status: 500, statusText: 'Internal' }))
    );

    // With 0 retries, should return the 500 response directly
    const res = await fetchWithTimeout('https://example.com/api', undefined, 5000, 0);
    expect(res.status).toBe(500);
  });
});

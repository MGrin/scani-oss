import { afterEach, describe, expect, test } from 'bun:test';
import { setSharedRedis } from '@scani/rate-limiter';
import { ResponsesProvider } from '../../src/providers/_openai-responses';

// A vision-capable provider with no PDF part: the shared base as OpenAI uses
// it, minus `supportsPdfFileInput`.
const visionWithoutPdf = (apiKey: string) =>
  new ResponsesProvider({
    providerKey: 'ai-test-vision',
    baseUrl: 'https://ai.test',
    model: 'test-model',
    visionModel: 'test-vision-model',
    apiKey,
    maxTokens: 4000,
    temperature: 0.1,
  });
describe('ResponsesProvider — providers without PDF support', () => {
  test('rejects a PDF before spending an upstream call', async () => {
    const p = visionWithoutPdf('test-key');
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await expect(
        p.parseScreenshot({ imageBase64: 'JVBERi0=', mimeType: 'application/pdf' })
      ).rejects.toThrow('PDF input not supported');
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('still sends an image as an input_image part, unchanged', async () => {
    const p = visionWithoutPdf('test-key');
    const originalFetch = globalThis.fetch;
    const capturedBodies: Array<{ input: Array<{ content: unknown }>; temperature?: number }> = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedBodies.push(JSON.parse(init.body as string));
      return new Response(
        JSON.stringify({
          output: [
            { type: 'message', content: [{ type: 'output_text', text: '{"holdings":[]}' }] },
          ],
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    try {
      await p.parseScreenshot({ imageBase64: 'aGVsbG8=', mimeType: 'image/png' });
      const parts = capturedBodies[0]?.input[1]?.content as Array<{
        type: string;
        image_url?: string;
        detail?: string;
      }>;
      expect(parts[1]?.type).toBe('input_image');
      expect(parts[1]?.image_url).toBe('data:image/png;base64,aGVsbG8=');
      expect(parts[1]?.detail).toBe('high');
      // The control for OpenAI's omission: a provider that accepts a
      // temperature still sends its configured one.
      expect(capturedBodies[0]?.temperature).toBe(0.1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('cloud AI deadlines cancel every operation before upstream dispatch', async () => {
  const provider = visionWithoutPdf('test-key');
  const signal = AbortSignal.abort(new Error('processing deadline'));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response('{}');
  }) as unknown as typeof fetch;
  try {
    await expect(
      provider.parseScreenshot({ imageBase64: 'aGVsbG8=', mimeType: 'image/png' }, signal)
    ).rejects.toThrow('processing deadline');
    await expect(provider.parseDocumentText('text', undefined, undefined, signal)).rejects.toThrow(
      'processing deadline'
    );
    await expect(provider.completeText('hello', undefined, signal)).rejects.toThrow(
      'processing deadline'
    );
    expect(calls).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

describe('AI availability reflects observations without inference probes', () => {
  test('missing credentials advertise no usable operations', async () => {
    const provider = visionWithoutPdf('');
    expect(await provider.getAvailability()).toMatchObject({
      state: 'missing',
      image: false,
      text: false,
      pdf: false,
    });
  });

  test('rejected credentials stop subsequent calls and never expose upstream contents', async () => {
    const provider = visionWithoutPdf('revoked-test-key');
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('sensitive credential and document contents', { status: 401 });
    }) as unknown as typeof fetch;
    try {
      expect((await provider.getAvailability()).state).toBe('unverified');
      await expect(provider.completeText('private document')).rejects.toMatchObject({
        kind: 'unrecoverable',
        message: 'AI processing unavailable (rejected)',
      });
      expect(await provider.getAvailability()).toMatchObject({ state: 'rejected', text: false });
      await expect(provider.completeText('again')).rejects.toThrow('AI processing unavailable');
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('transient failures remain distinct from credential rejection', async () => {
    const provider = visionWithoutPdf('outage-test-key');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('upstream outage', { status: 503 })) as unknown as typeof fetch;
    try {
      await expect(provider.completeText('hello')).rejects.toMatchObject({ kind: 'retryable' });
      expect((await provider.getAvailability()).state).toBe('transient');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('AI availability observations are bounded (SC-1397)', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    setSharedRedis(null);
  });

  function sharedRedis() {
    const sets: unknown[][] = [];
    setSharedRedis({
      get: async () => null,
      set: async (...args: unknown[]) => {
        sets.push(args);
        return 'OK';
      },
    } as never);
    return sets;
  }

  test('a 401 marks the key rejected for everyone for a day, not forever', async () => {
    // Built first: the rate limiter captures Redis at construction, and this
    // fake only answers the availability marker.
    const provider = visionWithoutPdf('revoked-key');
    const sets = sharedRedis();
    globalThis.fetch = (async () => new Response('no', { status: 401 })) as unknown as typeof fetch;
    await expect(provider.completeText('x')).rejects.toMatchObject({
      kind: 'unrecoverable',
    });
    expect(sets).toHaveLength(1);
    expect(sets[0]?.slice(1)).toEqual(['rejected', 'EX', 86_400]);
  });

  test('a 403 can be a region or model restriction, so it expires within the hour', async () => {
    const provider = visionWithoutPdf('restricted-key');
    const sets = sharedRedis();
    globalThis.fetch = (async () => new Response('no', { status: 403 })) as unknown as typeof fetch;
    await expect(provider.completeText('x')).rejects.toMatchObject({
      kind: 'unrecoverable',
    });
    expect(sets[0]?.slice(1)).toEqual(['rejected', 'EX', 3_600]);
  });

  test("a caller's own cancellation says nothing about the provider", async () => {
    const provider = visionWithoutPdf('fine-key');
    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = (async () => {
      throw new DOMException('aborted', 'AbortError');
    }) as unknown as typeof fetch;
    await expect(provider.completeText('x', undefined, controller.signal)).rejects.toThrow();
    expect((await provider.getAvailability()).state).toBe('unverified');
  });

  test('one slow request fails as transient without switching AI off for the process', async () => {
    const provider = visionWithoutPdf('slow-key');
    globalThis.fetch = (async () => {
      throw new DOMException('timed out', 'TimeoutError');
    }) as unknown as typeof fetch;
    await expect(provider.completeText('x')).rejects.toMatchObject({ kind: 'retryable' });
    expect((await provider.getAvailability()).state).toBe('unverified');
  });

  test('a network failure still backs off, so an outage is not retried by every job', async () => {
    const provider = visionWithoutPdf('offline-key');
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(provider.completeText('x')).rejects.toMatchObject({ kind: 'retryable' });
    expect((await provider.getAvailability()).state).toBe('transient');
  });
});

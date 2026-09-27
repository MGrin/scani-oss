import { describe, expect, test } from 'bun:test';
import { PerplexityProvider } from '../../src/providers/ai-perplexity';

// Perplexity stands in for "vision-capable, but no PDF part": it shares the
// `ChatCompletionsProvider` base with OpenAI and deliberately does NOT set
// `supportsPdfFileInput`.
describe('ChatCompletionsProvider — providers without PDF support', () => {
  test('rejects a PDF before spending an upstream call', async () => {
    const p = new PerplexityProvider('test-key');
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

  test('still sends an image as an image_url part, unchanged', async () => {
    const p = new PerplexityProvider('test-key');
    const originalFetch = globalThis.fetch;
    const capturedBodies: Array<{ messages: Array<{ content: unknown }> }> = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedBodies.push(JSON.parse(init.body as string));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"holdings":[]}' } }] }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    try {
      await p.parseScreenshot({ imageBase64: 'aGVsbG8=', mimeType: 'image/png' });
      const parts = capturedBodies[0]?.messages[1]?.content as Array<{
        type: string;
        image_url?: { url: string; detail: string };
      }>;
      expect(parts[1]?.type).toBe('image_url');
      expect(parts[1]?.image_url?.url).toBe('data:image/png;base64,aGVsbG8=');
      expect(parts[1]?.image_url?.detail).toBe('high');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('cloud AI deadlines cancel every operation before upstream dispatch', async () => {
  const provider = new PerplexityProvider('test-key');
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

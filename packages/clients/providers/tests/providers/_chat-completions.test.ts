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
    }) as typeof fetch;
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
    let capturedBody: { messages: Array<{ content: unknown }> } | null = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"holdings":[]}' } }] }),
        { status: 200 }
      );
    }) as typeof fetch;
    try {
      await p.parseScreenshot({ imageBase64: 'aGVsbG8=', mimeType: 'image/png' });
      const parts = capturedBody?.messages[1]?.content as Array<{
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

import { describe, expect, test } from 'bun:test';
import { OpenAIProvider } from '../../src/providers/ai-openai';

describe('OpenAIProvider', () => {
  test('declares ai-inference capability and providerKey', () => {
    const p = new OpenAIProvider('test-key');
    expect(p.providerKey).toBe('ai-openai');
    expect(p.capabilities).toContain('ai-inference');
  });

  test('isConfigured reflects api key presence', () => {
    expect(new OpenAIProvider('test-key').isConfigured()).toBe(true);
    expect(new OpenAIProvider('').isConfigured()).toBe(false);
  });

  test('parseScreenshot posts to /chat/completions with vision model', async () => {
    const p = new OpenAIProvider('test-key');
    const originalFetch = globalThis.fetch;
    let capturedBody: { model: string; messages: unknown[] } | null = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"holdings":[]}' } }],
        }),
        { status: 200 }
      );
    }) as typeof fetch;
    try {
      const result = (await p.parseScreenshot({
        imageBase64: 'aGVsbG8=',
        mimeType: 'image/png',
      })) as { holdings: unknown[] };
      expect(result.holdings).toEqual([]);
      expect(capturedBody?.model).toBe('gpt-4o');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('parseDocumentText posts to /chat/completions with text-only model', async () => {
    const p = new OpenAIProvider('test-key');
    const originalFetch = globalThis.fetch;
    let capturedBody: { model: string; messages: unknown[] } | null = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"holdings":[{"symbol":"AAPL"}]}' } }],
        }),
        { status: 200 }
      );
    }) as typeof fetch;
    try {
      const result = (await p.parseDocumentText('some text', 'broker statement')) as {
        holdings: Array<{ symbol: string }>;
      };
      expect(result.holdings[0]?.symbol).toBe('AAPL');
      expect(capturedBody?.model).toBe('gpt-4o-mini');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('completeText returns the message content', async () => {
    const p = new OpenAIProvider('test-key');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'hello world' } }] }), {
        status: 200,
      })) as typeof fetch;
    try {
      const text = await p.completeText('hi');
      expect(text).toBe('hello world');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('parseScreenshot throws when api key not configured', async () => {
    const p = new OpenAIProvider('');
    expect(p.parseScreenshot({ imageBase64: 'a', mimeType: 'image/png' })).rejects.toThrow(
      'apiKey not configured'
    );
  });

  test('completeText throws on non-2xx response', async () => {
    const p = new OpenAIProvider('test-key');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('rate limited', { status: 429 })) as typeof fetch;
    try {
      expect(p.completeText('hi')).rejects.toThrow('HTTP 429');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

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
      const result = await p.parseScreenshot({
        imageBase64: 'aGVsbG8=',
        mimeType: 'image/png',
      });
      expect((result.data as { holdings: unknown[] }).holdings).toEqual([]);
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
      const result = await p.parseDocumentText('some text', 'broker statement');
      const data = result.data as { holdings: Array<{ symbol: string }> };
      expect(data.holdings[0]?.symbol).toBe('AAPL');
      expect(capturedBody?.model).toBe('gpt-4o-mini');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('completeText returns the message content + token usage when reported', async () => {
    const p = new OpenAIProvider('test-key');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'hello world' } }],
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
        }),
        { status: 200 }
      )) as typeof fetch;
    try {
      const result = await p.completeText('hi');
      expect(result.data).toBe('hello world');
      expect(result.usage?.tokensIn).toBe(12);
      expect(result.usage?.tokensOut).toBe(4);
      expect(result.usage?.totalTokens).toBe(16);
      expect(result.usage?.upstreamCostUsd).toBeGreaterThan(0);
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

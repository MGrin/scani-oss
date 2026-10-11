import { describe, expect, test } from 'bun:test';
import { OpenAIProvider } from '../../src/providers/ai-openai';

interface InputPart {
  type: string;
  text?: string;
  image_url?: string;
  detail?: string;
  filename?: string;
  file_data?: string;
}

interface ResponsesRequest {
  model: string;
  input: string | Array<{ role: string; content: string | InputPart[] }>;
  max_output_tokens?: number;
  temperature?: number;
  text?: { format?: { type: string } };
  store?: boolean;
}

/** A Responses API body as gpt-5.6-luna returns it: a reasoning item ahead
    of the message, so a reader that takes `output[0]` finds no text. */
function responsesBody(text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    object: 'response',
    status: 'completed',
    output: [
      { type: 'reasoning', id: 'rs_1', summary: [] },
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    ...extra,
  });
}

async function capture(
  run: (p: OpenAIProvider) => Promise<unknown>,
  reply = responsesBody('{"holdings":[]}')
): Promise<{ url: string; body: ResponsesRequest; result: unknown }> {
  const p = new OpenAIProvider('test-key');
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: ResponsesRequest }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(init.body as string) });
    return new Response(reply, { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const result = await run(p);
    expect(calls).toHaveLength(1);
    return { url: calls[0]?.url ?? '', body: calls[0]?.body as ResponsesRequest, result };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function systemText(body: ResponsesRequest): string {
  const input = body.input as Array<{ role: string; content: string }>;
  expect(input[0]?.role).toBe('system');
  return input[0]?.content ?? '';
}

function userParts(body: ResponsesRequest): InputPart[] {
  const input = body.input as Array<{ role: string; content: InputPart[] }>;
  expect(input[1]?.role).toBe('user');
  return input[1]?.content ?? [];
}

/** The live API refuses `json_object` unless "json" appears in the INPUT
    messages, and it does not count top-level `instructions`: measured
    2026-10-05, HTTP 400 "Response input messages must contain the word
    'json'". So the system prompt travels as an input message. */
function expectJsonModeAccepted(body: ResponsesRequest): void {
  expect(body.text?.format?.type).toBe('json_object');
  expect(body).not.toHaveProperty('instructions');
  expect(JSON.stringify(body.input).toLowerCase()).toContain('json');
}

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

  test('parseScreenshot throws when api key not configured', async () => {
    const p = new OpenAIProvider('');
    expect(p.parseScreenshot({ imageBase64: 'a', mimeType: 'image/png' })).rejects.toThrow(
      'AI processing unavailable (missing)'
    );
  });

  test('completeText throws on non-2xx response', async () => {
    const p = new OpenAIProvider('test-key');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('rate limited', { status: 429 })) as unknown as typeof fetch;
    try {
      expect(p.completeText('hi')).rejects.toThrow('AI processing unavailable (transient)');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('OpenAIProvider on the Responses API (SC-1581)', () => {
  test('parseScreenshot posts an input_image to /v1/responses and is not stored', async () => {
    const { url, body, result } = await capture((p) =>
      p.parseScreenshot({ imageBase64: 'aGVsbG8=', mimeType: 'image/png' })
    );
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(body.model).toBe('gpt-5.6-luna');
    // Responses are retained by OpenAI unless the request says otherwise,
    // and these carry a user's uploaded statement.
    expect(body.store).toBe(false);
    expect(systemText(body)).toContain('holdings');
    expectJsonModeAccepted(body);
    expect(body.max_output_tokens).toBe(4000);
    expect('temperature' in body).toBe(false);
    expect(body).not.toHaveProperty('messages');
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('response_format');
    const parts = userParts(body);
    expect(parts[0]?.type).toBe('input_text');
    expect(parts[1]).toEqual({
      type: 'input_image',
      image_url: 'data:image/png;base64,aGVsbG8=',
      detail: 'high',
    });
    expect((result as { data: { holdings: unknown[] } }).data.holdings).toEqual([]);
  });

  test('parseScreenshot sends a PDF as an input_file, never as an image', async () => {
    const { body } = await capture(
      (p) =>
        p.parseScreenshot({
          imageBase64: 'JVBERi0=',
          mimeType: 'application/pdf',
          systemPrompt: 'extract invoices as JSON',
        }),
      responsesBody('{"invoices":[]}')
    );
    const parts = userParts(body);
    expect(parts[1]?.type).toBe('input_file');
    expect(parts[1]?.filename).toEndWith('.pdf');
    expect(parts[1]?.file_data).toBe('data:application/pdf;base64,JVBERi0=');
    expect(parts.some((part) => part.type === 'input_image')).toBe(false);
  });

  test('a caller system prompt replaces the default holdings instructions', async () => {
    const { body } = await capture(
      (p) =>
        p.parseScreenshot({
          imageBase64: 'JVBERi0=',
          mimeType: 'application/pdf',
          systemPrompt: 'You are extracting structured invoice data as JSON.',
        }),
      responsesBody('{"invoices":[]}')
    );
    expect(systemText(body)).toBe('You are extracting structured invoice data as JSON.');
    expectJsonModeAccepted(body);
    // The default user prompt ("Extract every visible token holding")
    // would contradict the replacement prompt, so it must be gone too.
    expect(userParts(body)[0]?.text).not.toContain('token holding');
  });

  test('parseDocumentText sends text only and parses the JSON message', async () => {
    const { url, body, result } = await capture(
      (p) => p.parseDocumentText('some text', 'broker statement'),
      responsesBody('{"holdings":[{"symbol":"AAPL"}]}')
    );
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(body.store).toBe(false);
    expectJsonModeAccepted(body);
    expect(JSON.stringify(body.input)).toContain('some text');
    expect(JSON.stringify(body.input)).not.toContain('input_image');
    const data = (result as { data: { holdings: Array<{ symbol: string }> } }).data;
    expect(data.holdings[0]?.symbol).toBe('AAPL');
  });

  test('completeText returns the output text and reads Responses usage', async () => {
    const { body, result } = await capture(
      (p) => p.completeText('hi', { maxTokens: 50 }),
      responsesBody('hello world', {
        usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
      })
    );
    expect(body.store).toBe(false);
    expect(body.max_output_tokens).toBe(50);
    expect(body).not.toHaveProperty('text');
    const r = result as { data: string; usage?: Record<string, number> };
    expect(r.data).toBe('hello world');
    expect(r.usage?.tokensIn).toBe(12);
    expect(r.usage?.tokensOut).toBe(4);
    expect(r.usage?.totalTokens).toBe(16);
    expect(r.usage?.upstreamCostUsd).toBeCloseTo((12 * 0.2 + 4 * 1.2) / 1_000_000, 12);
  });

  test('an incomplete response is reported by its reason, not as bad JSON', async () => {
    const p = new OpenAIProvider('test-key');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        responsesBody('{"holdings":[{"sym', {
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
        }),
        { status: 200 }
      )) as unknown as typeof fetch;
    try {
      await expect(
        p.parseScreenshot({ imageBase64: 'aGVsbG8=', mimeType: 'image/png' })
      ).rejects.toThrow('response incomplete (max_output_tokens)');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a response with no output_text is an error, not an empty result', async () => {
    const p = new OpenAIProvider('test-key');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'refusal', refusal: 'no' }],
            },
          ],
        }),
        { status: 200 }
      )) as unknown as typeof fetch;
    try {
      await expect(p.parseDocumentText('x')).rejects.toThrow('no content in response');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

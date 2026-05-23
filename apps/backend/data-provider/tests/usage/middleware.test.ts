import { describe, expect, it } from 'bun:test';
import { TRPCError } from '@trpc/server';
import { buildUsageMiddleware, createUsageContext } from '../../src/usage/middleware';
import type { UsageEvent, UsageSink } from '../../src/usage/sink';

class CapturingSink implements UsageSink {
  events: UsageEvent[] = [];
  record(e: UsageEvent): void {
    this.events.push(e);
  }
  async flush(): Promise<void> {}
}

interface TestCtx {
  auth: { apiKeyId: string; tenantId: string; ownerUserId: string | null } | null;
  cloudUser: { id: string } | null;
  requestId: string;
  usage: ReturnType<typeof createUsageContext>;
}

function makeCtx(): TestCtx {
  return {
    auth: { apiKeyId: 'k1', tenantId: 't1', ownerUserId: 'u1' },
    cloudUser: null,
    requestId: 'req-1',
    usage: createUsageContext(),
  };
}

function firstEvent(sink: CapturingSink): UsageEvent {
  const e = sink.events[0];
  if (!e) throw new Error('expected at least one usage event');
  return e;
}

describe('createUsageContext', () => {
  it('annotate merges shallow + deep-merges metadata', () => {
    const u = createUsageContext();
    u.annotate({ provider: 'openai', tokensIn: 10 });
    u.annotate({ tokensOut: 20, metadata: { model: 'gpt-4o' } });
    u.annotate({ metadata: { latencyMs: 120 } });
    expect(u.getAnnotation()).toEqual({
      provider: 'openai',
      tokensIn: 10,
      tokensOut: 20,
      metadata: { model: 'gpt-4o', latencyMs: 120 },
    });
  });
});

describe('buildUsageMiddleware', () => {
  it('records "ok" outcome with status 200 on success', async () => {
    const sink = new CapturingSink();
    const mw = buildUsageMiddleware({ sink });
    const ctx = makeCtx();
    const result = await mw({
      ctx,
      path: 'pricing.getPrice',
      type: 'mutation',
      next: async () => ({ ok: true }),
    });
    expect(result).toEqual({ ok: true });
    expect(sink.events).toHaveLength(1);
    expect(firstEvent(sink)).toMatchObject({
      route: 'pricing.getPrice',
      provider: 'pricing',
      outcome: 'ok',
      statusCode: 200,
      subject: 'u1',
      apiKeyId: 'k1',
      tenantId: 't1',
    });
  });

  it('records "error" outcome with mapped status when next() throws TRPCError', async () => {
    const sink = new CapturingSink();
    const mw = buildUsageMiddleware({ sink });
    const ctx = makeCtx();
    await expect(
      mw({
        ctx,
        path: 'ai.parseScreenshot',
        type: 'mutation',
        next: async () => {
          throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'rate limit' });
        },
      })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(sink.events).toHaveLength(1);
    expect(firstEvent(sink)).toMatchObject({
      route: 'ai.parseScreenshot',
      provider: 'ai',
      outcome: 'rate_limited',
      statusCode: 429,
      errorCode: 'TOO_MANY_REQUESTS',
    });
  });

  it('annotation.provider overrides the inferred provider', async () => {
    const sink = new CapturingSink();
    const mw = buildUsageMiddleware({ sink });
    const ctx = makeCtx();
    await mw({
      ctx,
      path: 'ai.parseScreenshot',
      type: 'mutation',
      next: async () => {
        ctx.usage.annotate({ provider: 'custom-llm', tokensIn: 1024, tokensOut: 256 });
        return { ok: true };
      },
    });
    expect(firstEvent(sink).provider).toBe('custom-llm');
    expect(firstEvent(sink).tokensIn).toBe(1024);
    expect(firstEvent(sink).tokensOut).toBe(256);
  });

  it('falls back to cloudUser.id for subject when ctx.auth is null (cookie session)', async () => {
    const sink = new CapturingSink();
    const mw = buildUsageMiddleware({ sink });
    const ctx = makeCtx();
    ctx.auth = null;
    ctx.cloudUser = { id: 'cloud-user-1' };
    await mw({
      ctx,
      path: 'usage.summary',
      type: 'query',
      next: async () => ({ ok: true }),
    });
    expect(firstEvent(sink).subject).toBe('cloud-user-1');
    expect(firstEvent(sink).apiKeyId).toBeNull();
    expect(firstEvent(sink).tenantId).toBeNull();
  });

  it('drops apiKeyId/tenantId for OSS env-key (apiKeyId="oss-shared-key", tenantId="oss"|"dev")', async () => {
    const sink = new CapturingSink();
    const mw = buildUsageMiddleware({ sink });
    const ctx = makeCtx();
    ctx.auth = { apiKeyId: 'oss-shared-key', tenantId: 'oss', ownerUserId: null };
    await mw({
      ctx,
      path: 'pricing.getPrice',
      type: 'mutation',
      next: async () => ({ ok: true }),
    });
    expect(firstEvent(sink).apiKeyId).toBeNull();
    expect(firstEvent(sink).tenantId).toBeNull();
    expect(firstEvent(sink).subject).toBeNull();
  });

  it('records duration in milliseconds', async () => {
    const sink = new CapturingSink();
    const mw = buildUsageMiddleware({ sink });
    const ctx = makeCtx();
    await mw({
      ctx,
      path: 'pricing.getPrice',
      type: 'mutation',
      next: async () => {
        await new Promise((r) => setTimeout(r, 25));
        return { ok: true };
      },
    });
    expect(firstEvent(sink).durationMs).toBeGreaterThanOrEqual(20);
    expect(firstEvent(sink).durationMs).toBeLessThan(500);
  });

  it('inferred provider is "unknown" for paths without a top-level namespace', async () => {
    const sink = new CapturingSink();
    const mw = buildUsageMiddleware({ sink });
    const ctx = makeCtx();
    await mw({
      ctx,
      path: '',
      type: 'query',
      next: async () => ({ ok: true }),
    });
    expect(firstEvent(sink).provider).toBe('unknown');
  });
});

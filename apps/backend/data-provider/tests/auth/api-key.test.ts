import { describe, expect, it } from 'bun:test';
import { TRPCError } from '@trpc/server';
import { OSS_KEY_ID, validateBearerToken } from '../../src/auth/api-key';

const ENV_TOKEN = 'env-superuser-token-1234567890';

describe('validateBearerToken — dev/OSS mode (no env, no DB)', () => {
  it('accepts any caller and returns dev context', async () => {
    const ctx = await validateBearerToken({
      authHeader: 'Bearer whatever',
      expectedToken: undefined,
      cloudDb: null,
    });
    expect(ctx).toEqual({
      apiKeyId: OSS_KEY_ID,
      tenantId: 'dev',
      ownerUserId: null,
      tier: 'oss',
    });
  });

  it('accepts a missing header in dev (zero-config docker-compose)', async () => {
    const ctx = await validateBearerToken({
      authHeader: undefined,
      expectedToken: undefined,
      cloudDb: null,
    });
    expect(ctx.tier).toBe('oss');
  });
});

describe('validateBearerToken — OSS Tier 1 (env token, no DB)', () => {
  it('rejects missing Authorization header', async () => {
    await expect(
      validateBearerToken({ authHeader: null, expectedToken: ENV_TOKEN, cloudDb: null })
    ).rejects.toBeInstanceOf(TRPCError);
  });

  it('rejects non-Bearer scheme', async () => {
    await expect(
      validateBearerToken({
        authHeader: `Basic ${ENV_TOKEN}`,
        expectedToken: ENV_TOKEN,
        cloudDb: null,
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rejects empty Bearer token', async () => {
    await expect(
      validateBearerToken({
        authHeader: 'Bearer ',
        expectedToken: ENV_TOKEN,
        cloudDb: null,
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('accepts the exact env token (case-sensitive Bearer prefix)', async () => {
    const ctx = await validateBearerToken({
      authHeader: `Bearer ${ENV_TOKEN}`,
      expectedToken: ENV_TOKEN,
      cloudDb: null,
    });
    expect(ctx.tier).toBe('oss');
    expect(ctx.tenantId).toBe('oss');
  });

  it('accepts lower-case bearer prefix (RFC 7235 §2.1 is case-insensitive)', async () => {
    const ctx = await validateBearerToken({
      authHeader: `bearer ${ENV_TOKEN}`,
      expectedToken: ENV_TOKEN,
      cloudDb: null,
    });
    expect(ctx.tier).toBe('oss');
  });

  it('rejects a token that differs by one character', async () => {
    const tampered = `${ENV_TOKEN.slice(0, -1)}X`;
    await expect(
      validateBearerToken({
        authHeader: `Bearer ${tampered}`,
        expectedToken: ENV_TOKEN,
        cloudDb: null,
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rejects a token with extra trailing chars (length mismatch)', async () => {
    await expect(
      validateBearerToken({
        authHeader: `Bearer ${ENV_TOKEN}extra`,
        expectedToken: ENV_TOKEN,
        cloudDb: null,
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rejects a token shorter than expected', async () => {
    await expect(
      validateBearerToken({
        authHeader: `Bearer ${ENV_TOKEN.slice(0, -3)}`,
        expectedToken: ENV_TOKEN,
        cloudDb: null,
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('validateBearerToken — env-token superuser fallback in managed mode', () => {
  it('accepts the env token even when a cloudDb is wired up', async () => {
    // The DB lookup path is bypassed when the env token matches — Scani
    // ops can always reach the service even if the cloud_api_keys table
    // is misconfigured.
    const ctx = await validateBearerToken({
      authHeader: `Bearer ${ENV_TOKEN}`,
      expectedToken: ENV_TOKEN,
      // biome-ignore lint/suspicious/noExplicitAny: db is not consulted on this path
      cloudDb: {} as any,
    });
    expect(ctx.tier).toBe('oss');
    expect(ctx.apiKeyId).toBe(OSS_KEY_ID);
  });
});

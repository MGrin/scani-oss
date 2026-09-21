import { describe, expect, test } from 'bun:test';
import { ogRouter } from '../../../src/presentation/routers/og';
import { buildAuthedContext } from '../../helpers/test-context';

/**
 * SC-1284. The 2026-09-19 attacker made 625 `og.fetchMetadata` calls and not
 * one of them recorded what was fetched, so whether the SSRF bypass was used
 * could not be answered. Every call now records the requested HOSTNAME — never
 * the full URL, whose path and query can carry a token.
 */
describe('og.fetchMetadata records the requested hostname', () => {
  test('a refused fetch records the host and why it was refused', async () => {
    const ctx = buildAuthedContext();
    const result = await ogRouter
      .createCaller(ctx)
      .fetchMetadata({ url: 'http://[::ffff:127.0.0.1]/admin?token=secret' });

    expect(result.title).toBe('');
    expect(ctx.usage.getAnnotation().metadata).toEqual({
      host: '[::ffff:7f00:1]',
      refused: 'blocked-host',
    });
    expect(JSON.stringify(ctx.usage.getAnnotation())).not.toContain('secret');
  });

  test('each call records its own host', async () => {
    const a = buildAuthedContext();
    const b = buildAuthedContext();
    await ogRouter.createCaller(a).fetchMetadata({ url: 'http://10.0.0.1/' });
    await ogRouter.createCaller(b).fetchMetadata({ url: 'http://169.254.169.254/latest' });

    expect(a.usage.getAnnotation().metadata?.host).toBe('10.0.0.1');
    expect(b.usage.getAnnotation().metadata?.host).toBe('169.254.169.254');
  });
});

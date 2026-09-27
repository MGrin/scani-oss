import { afterEach, beforeEach, expect, test } from 'bun:test';
import { LocalEmailService } from '@scani/email';
import { getSharedRedis, setSharedRedis } from '@scani/rate-limiter';
import type { Redis } from 'ioredis';
import { Container } from 'typedi';
import { restoreContainerAfterAll } from '../../../../../../packages/business/domain/test/helpers/container';
import { emailRouter } from '../../../src/presentation/routers/email';
import { buildCustomerContext } from '../../helpers/test-context';

restoreContainerAfterAll();
const previousRedis = getSharedRedis();
const deliveries: unknown[] = [];
beforeEach(() => {
  deliveries.length = 0;
  const rows = new Map<string, string>();
  setSharedRedis({
    get: async (k: string) => rows.get(k) ?? null,
    set: async (k: string, v: string, ...args: unknown[]) => {
      if (args.includes('NX') && rows.has(k)) return null;
      rows.set(k, v);
      return 'OK';
    },
    eval: async (script: string, _count: number, key: string, marker: string, result: string) => {
      if (!script.includes("redis.call('GET'")) return 0;
      if (rows.get(key) !== marker) return null;
      rows.set(key, result);
      return 'OK';
    },
  } as unknown as Redis);
  Container.set(LocalEmailService, {
    sendOtp: async (input: unknown) => deliveries.push(input),
    sendMagicLink: async (input: unknown) => deliveries.push(input),
  } as unknown as LocalEmailService);
});
afterEach(() => setSharedRedis(previousRedis));
test('customer auth email has fixed sender/brand and replays without resending', async () => {
  const caller = emailRouter.createCaller(buildCustomerContext());
  const input = {
    kind: 'otp' as const,
    to: 'reader@example.com',
    appOrigin: 'https://money.example.com',
    code: '123456',
    type: 'sign-in' as const,
  };
  await caller.auth(input);
  await caller.auth(input);
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0]).toMatchObject({
    to: input.to,
    code: '123456',
    brand: {
      from: '"Scani self-hosted" <welcome@scani.xyz>',
      appName: 'Scani self-hosted (money.example.com)',
    },
  });
});
test('customer cannot supply arbitrary mail or a deceptive auth URL', async () => {
  const caller = emailRouter.createCaller(buildCustomerContext());
  const input = {
    kind: 'magic-link',
    to: 'reader@example.com',
    appOrigin: 'https://money.example.com',
    url: 'https://api.example.com/api/auth/magic-link/verify?token=abc',
  };
  await expect(caller.auth({ ...input, html: 'arbitrary' } as never)).rejects.toMatchObject({
    code: 'BAD_REQUEST',
  });
  await expect(
    caller.auth({ ...input, url: 'https://user@evil.example/anything' } as never)
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  await expect(
    caller.auth({
      ...input,
      url: 'https://api.example.com/api/auth/magic-link/verify?token=abc&callbackURL=https://evil.example',
    } as never)
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  await expect(
    caller.send({ from: 'security@scani.xyz', to: 'reader@example.com', subject: 'x', text: 'x' })
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(deliveries).toHaveLength(0);
});

test('an authentication target cannot differ from the hostname printed in the email', async () => {
  await expect(
    emailRouter.createCaller(buildCustomerContext()).auth({
      kind: 'magic-link',
      to: 'reader@example.com',
      appOrigin: 'https://app.scani.xyz',
      url: 'https://attacker.example/api/auth/magic-link/verify?token=x',
    })
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(deliveries).toHaveLength(0);
});

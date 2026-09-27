import { withDeadline } from '@scani/deadline';
import { createComponentLogger } from '@scani/logging';
import { createOutflowLimiter } from '@scani/rate-limiter';
import { TRPCError } from '@trpc/server';
import type { Redis } from 'ioredis';
import { Service } from 'typedi';

const REDIS_TIMEOUT_MS = 250;

const CACHE_RESULT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('SET', KEYS[1], ARGV[2], 'EX', 300)
end
return nil
`;

function bounded<T>(work: Promise<T>): Promise<T> {
  return withDeadline(
    work,
    REDIS_TIMEOUT_MS,
    () =>
      new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Cloud processing protection unavailable',
      })
  );
}

const log = createComponentLogger('processing-guard');

@Service()
export class ProcessingGuard {
  async run<T>(
    redis: Redis | null,
    owner: string,
    operation: 'ai' | 'auth-mail',
    input: unknown,
    work: (signal: AbortSignal) => Promise<T>
  ): Promise<{ result: T; replayed: boolean }> {
    if (!redis)
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Cloud processing protection unavailable',
      });
    const digest = new Bun.CryptoHasher('sha256')
      .update(JSON.stringify([owner, operation, input]))
      .digest('hex');
    const key = `processing:v1:${digest}`;
    const cached = await bounded(redis.get(key));
    if (cached) {
      if (cached.startsWith('pending:'))
        throw new TRPCError({
          code: 'CONFLICT',
          message:
            'This operation is pending or its outcome is uncertain. Retry after ten minutes.',
        });
      return { result: JSON.parse(cached) as T, replayed: true };
    }
    const limiter = createOutflowLimiter({
      redis,
      namespace: `inflow:processing:${operation}`,
      maxRequests: operation === 'ai' ? 30 : 20,
      windowMs: 3_600_000,
    });
    const slot = await bounded(limiter.tryConsume(owner));
    if (!slot.ok)
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Cloud operation hourly limit reached',
      });
    const marker = `pending:${crypto.randomUUID()}`;
    if ((await bounded(redis.set(key, marker, 'EX', 600, 'NX'))) !== 'OK')
      throw new TRPCError({ code: 'CONFLICT', message: 'Operation already in progress' });
    try {
      const result = await work(AbortSignal.timeout(90_000));
      const encoded = JSON.stringify(result);
      // Only short-lived replay results are retained; requests are represented by a hash.
      if (encoded.length <= 1_000_000) {
        try {
          await bounded(redis.eval(CACHE_RESULT, 1, key, marker, encoded));
        } catch {
          // The paid result must reach usage accounting even when replay persistence fails.
          log.warn({ operation }, 'Replay cache unavailable after successful processing');
        }
      }
      return { result, replayed: false };
    } catch {
      // Keep the marker: a timeout does not establish that the upstream did no paid work.
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Cloud processing failed; outcome may be uncertain. Retry after ten minutes.',
      });
    }
  }
}

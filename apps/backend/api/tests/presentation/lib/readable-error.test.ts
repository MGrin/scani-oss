import { describe, expect, test } from 'bun:test';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { readableError } from '../../../src/presentation/lib/readable-error';
import { strictInput } from '../../../src/presentation/lib/strict-input';

/**
 * SC-1492: an input refusal is a TRPCError whose message is the zod issue list
 * serialised as JSON, so Sentry titled 31 events by its first line, `[`.
 */

function refusal(schema: z.ZodTypeAny, input: unknown): TRPCError {
  const result = schema.safeParse(input);
  if (result.success) throw new Error('expected the input to be refused');
  return new TRPCError({ code: 'BAD_REQUEST', cause: result.error });
}

describe('readableError', () => {
  test('an unrecognized key reads as the path and the key, not `[`', () => {
    const error = refusal(strictInput(z.object({ limit: z.number() })), { limit: 1, offset: 5 });
    expect(error.message.startsWith('[')).toBe(true);

    const readable = readableError(error, 'transferReview.listAnswered');

    expect(readable.message).toBe(
      "transferReview.listAnswered: (input) — Unrecognized key(s) in object: 'offset'"
    );
    expect(readable.name).toBe('TRPCInputError');
  });

  test('a nested issue names its path, and further issues are counted', () => {
    const schema = z.object({
      data: z.object({ name: z.string(), qty: z.number() }),
      id: z.string(),
    });
    const error = refusal(schema, { data: { name: 1, qty: 'x' }, id: 2 });

    const readable = readableError(error, 'holdings.update');

    expect(readable.message).toBe(
      'holdings.update: data.name — Expected string, received number (+2 more)'
    );
  });

  test('the original error rides along as the cause, so the full issue list survives', () => {
    const error = refusal(z.object({ id: z.string() }), {});
    const readable = readableError(error, 'holdings.get') as Error & { cause?: unknown };
    expect(readable.cause).toBe(error);
  });

  test('a message that is the issue list as JSON is read even without a zod cause', () => {
    const error = new TRPCError({
      code: 'BAD_REQUEST',
      message: JSON.stringify([{ code: 'too_big', path: ['sizeBytes'], message: 'Too big' }]),
    });
    expect(readableError(error, 'storage.presign').message).toBe(
      'storage.presign: sizeBytes — Too big'
    );
  });

  test('CONTROL: any other error comes back as the same object', () => {
    const plain = new Error('boom');
    expect(readableError(plain, 'x.y')).toBe(plain);
    const notFound = new TRPCError({ code: 'NOT_FOUND', message: 'Holding not found' });
    expect(readableError(notFound, 'x.y')).toBe(notFound);
    const notIssues = new TRPCError({ code: 'BAD_REQUEST', message: '[not json' });
    expect(readableError(notIssues, 'x.y')).toBe(notIssues);
  });
});

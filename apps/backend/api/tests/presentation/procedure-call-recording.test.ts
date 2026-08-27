import { describe, expect, test } from 'bun:test';
import { procedureCallRecorder } from '@scani/db';
import { TRPCError } from '@trpc/server';
import { protectedProcedure, publicProcedure, router } from '../../src/presentation/trpc';

/**
 * SC-742. The api now keeps a retained record of which tRPC procedures anything
 * still calls, so "is anything calling X" has an answer that outlives a
 * 19-minute log buffer.
 *
 * THIS FILE EXISTS BECAUSE THE HOOK COULD BE BORN SILENT. `trpc.ts` already
 * carries the scar: tRPC v10 middlewares do not THROW a failed `next()`, they
 * return `{ ok: false, error }`, so a hook written into the `catch` block — the
 * place every instinct puts it — never fires, and reads as correct to anyone
 * reviewing it. A hook that never fires and an event that never happens produce
 * identical output. So this drives the SHIPPED `publicProcedure` /
 * `protectedProcedure` exports rather than a re-implementation: a recorder
 * deleted from the real chain turns this file red.
 *
 * The recorder is a process-wide singleton and `bun test` runs every file in
 * one process, so other files exercising these same builders leave entries in
 * the buffer. Every assertion here is therefore CONTAINMENT of a name unique to
 * this file, never an exact buffer contents or a count — a count-based
 * assertion would be red or green depending on file order.
 *
 * Nothing here reaches a database: the buffer is in memory and is never
 * flushed by this file.
 */

/** Enough context for the logging middleware; nothing here reaches a database. */
function context(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'test-request',
    startTime: Date.now(),
    requestCache: new Map<string, unknown>(),
    headers: null,
    sessionRevokeLimiter: null,
    userId: 'user-1',
    email: 'someone@example.com',
    isAuthenticated: true,
    dbUser: null,
    ...overrides,
  } as unknown as Parameters<typeof probe.createCaller>[0];
}

const probe = router({
  sc742RecordedQuery: publicProcedure.query(() => 'ok'),
  sc742ThrowingQuery: publicProcedure.query(() => {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'boom' });
  }),
  sc742RefusedQuery: protectedProcedure.query(() => 'ok'),
  sc742NeverCalled: publicProcedure.query(() => 'ok'),
});

describe('every tRPC invocation is recorded by procedure name', () => {
  test('a successful call records its own procedure path', async () => {
    await probe.createCaller(context()).sc742RecordedQuery();
    expect(procedureCallRecorder.pending()).toContain('sc742RecordedQuery');
  });

  /**
   * The point of counting the INVOCATION rather than the OUTCOME. A procedure
   * that only ever throws is still being called by something, and that is
   * precisely the procedure somebody is about to decide is dead.
   */
  test('a call that throws is still recorded', async () => {
    await probe
      .createCaller(context())
      .sc742ThrowingQuery()
      .catch(() => undefined);
    expect(procedureCallRecorder.pending()).toContain('sc742ThrowingQuery');
  });

  test('a call refused by a later middleware is still recorded', async () => {
    // The recorder sits above the auth middleware, so an UNAUTHORIZED refusal
    // never reaches the resolver — and still counts as somebody calling it.
    const error = await probe
      .createCaller(context({ userId: null, isAuthenticated: false }))
      .sc742RefusedQuery()
      .catch((e: unknown) => e);
    expect((error as TRPCError).code).toBe('UNAUTHORIZED');
    expect(procedureCallRecorder.pending()).toContain('sc742RefusedQuery');
  });

  /**
   * MUST-BE-ABSENT arm. Without it every assertion above is equally satisfied
   * by a recorder that buffers every procedure in the router the moment the
   * router is built, which would make the whole table say "everything is
   * called" — the one answer that would be worse than having no table.
   *
   * The arm re-establishes its own population first: an empty buffer would
   * satisfy `not.toContain` vacuously, and an empty buffer is exactly what a
   * recorder that never fires produces.
   */
  test('a declared but never-called procedure is NOT recorded', async () => {
    await probe.createCaller(context()).sc742RecordedQuery();
    const pending = procedureCallRecorder.pending();
    expect(pending).toContain('sc742RecordedQuery'); // the population is non-empty
    expect(pending).not.toContain('sc742NeverCalled');
  });
});

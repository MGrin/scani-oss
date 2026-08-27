import { describe, expect, test } from 'bun:test';
import { TRPCError } from '@trpc/server';
import {
  protectedProcedure,
  publicProcedure,
  router,
  traceProcedureSpan,
} from '../../src/presentation/trpc';

/**
 * SC-751. Every tRPC call now opens a Sentry span, because nothing else on this
 * process opens one: `@sentry/node` instruments `node:http` and the api is
 * Elysia on `Bun.serve`, so the only transactions the project had ever stored
 * were better-auth's own five routes.
 *
 * WHAT THIS FILE CAN AND CANNOT SEE. With `SENTRY_DSN` unset — the test default
 * — `withSpan` is a pass-through by design, so no span is recorded anywhere and
 * nothing here can observe one. That half is pinned where it can be measured
 * for real, in `packages/infra/logging/tests/sentry-span-over-bun-serve.test.ts`,
 * which drives the actual SDK against a local envelope sink and asserts on what
 * was transmitted.
 *
 * So this file answers the other half, and it is the half that rots: is the
 * hook WIRED, and is it wired where it was meant to be? It asserts against the
 * SHIPPED `publicProcedure` / `protectedProcedure` builders rather than a
 * rebuilt chain, so a middleware dropped from the real exports turns this red.
 * `trpc.ts` carries two scars from hooks that were born silent and read as
 * correct to a reviewer; a placement assertion is the cheap defence.
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
  sc751TracedQuery: publicProcedure.query(() => 'ok'),
  sc751ThrowingQuery: publicProcedure.query(() => {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'boom' });
  }),
  sc751RefusedQuery: protectedProcedure.query(() => 'ok'),
});

/** tRPC v10 stores the middleware functions themselves, in application order. */
function middlewaresOf(procedure: unknown): unknown[] {
  return (procedure as { _def: { middlewares: unknown[] } })._def.middlewares;
}

describe('the tracing middleware is wired into the shipped procedure builders', () => {
  /**
   * By IDENTITY, not by name and not by count. A name match survives the
   * function being replaced by a different one that happens to be called the
   * same; a count survives it being swapped for something else entirely. Both
   * of those are the edit this assertion exists to catch.
   */
  test.each([
    ['publicProcedure', publicProcedure],
    ['protectedProcedure', protectedProcedure],
  ])('%s carries traceProcedureSpan, outermost', (_name, procedure) => {
    const middlewares = middlewaresOf(procedure);
    // The population, stated before anything is claimed about it: an empty
    // chain would satisfy every `not.toContain` in this file vacuously and
    // would be exactly what a builder stripped of its middlewares looks like.
    expect(middlewares.length).toBeGreaterThan(1);
    expect(middlewares).toContain(traceProcedureSpan as unknown);
    // Outermost is the property, not merely present. A span that starts after
    // the demo refusal or after the auth check measures neither, and both are
    // calls somebody made that cost real latency.
    expect(middlewares[0]).toBe(traceProcedureSpan as unknown);
  });

  /**
   * MUST-BE-ABSENT arm for the identity check itself. Without it, `toContain`
   * passing tells you nothing about whether the comparison can distinguish
   * anything: a `toContain` against a chain that held every function in the
   * module would pass just as well.
   */
  test('a function that is not in the chain is not reported as being in it', () => {
    function notAMiddleware() {
      return undefined;
    }
    expect(middlewaresOf(publicProcedure)).not.toContain(notAMiddleware as unknown);
  });
});

/**
 * The span wrapper sits in the request path of every procedure in the api, so
 * the cost of it being wrong is not a missing metric — it is the product. These
 * assert the insertion changed no procedure semantics.
 *
 * They are deliberately NOT evidence that a span is produced: with no DSN the
 * wrapper is a pass-through, so they would pass equally against a middleware
 * that did nothing at all. That claim belongs to the sink-backed test named at
 * the top of this file.
 */
describe('wrapping a procedure in a span does not change what it returns', () => {
  test('a successful call still returns its value', async () => {
    await expect(probe.createCaller(context()).sc751TracedQuery()).resolves.toBe('ok');
  });

  test('a throwing call still propagates its error', async () => {
    const error = await probe
      .createCaller(context())
      .sc751ThrowingQuery()
      .catch((e: unknown) => e);
    expect((error as TRPCError).code).toBe('INTERNAL_SERVER_ERROR');
  });

  test('a call refused by a later middleware still refuses', async () => {
    const error = await probe
      .createCaller(context({ userId: null, isAuthenticated: false }))
      .sc751RefusedQuery()
      .catch((e: unknown) => e);
    expect((error as TRPCError).code).toBe('UNAUTHORIZED');
  });
});

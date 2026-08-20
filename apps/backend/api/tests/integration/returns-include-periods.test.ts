/**
 * `includePeriods` through the real router (SC-471's open note, answered by
 * SC-458).
 *
 * The flag was added at the response-shaping layer and had never been
 * exercised through a tRPC client, because nothing in the UI called the route.
 * SC-458 wired four screens to it, so it is exercised now — and this pins what
 * they depend on: the flag defaults to OFF, both period series are absent
 * rather than empty when it is, and both come back when it is on.
 *
 * A caller rather than a unit test on the shaping function, because the two
 * things most likely to be wrong are in between: zod's `.default(false)` on an
 * input the client omits entirely, and the handler picking the trimmed object.
 */

import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type * as schema from '@scani/db/schema';
import { ReturnsService } from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { Container } from 'typedi';
import { makeAuthedCaller } from '../helpers/test-caller';

restoreContainerAfterAll();

let realReturnsService: ReturnsService;

beforeAll(() => {
  realReturnsService = Container.get(ReturnsService);
});

afterEach(() => {
  Container.set(ReturnsService, realReturnsService);
});

const USER = {
  id: 'user-1',
  email: 'user-1@scani.local',
  name: 'Test User',
  baseCurrencyId: 'token-usd',
  image: null,
  emailVerified: false,
  createdAt: new Date(),
  updatedAt: new Date(),
} as typeof schema.users.$inferSelect;

function stubReturns(): void {
  Container.set(ReturnsService, {
    compute: async () => ({
      status: 'ok' as const,
      returns: {
        scope: { kind: 'user' as const },
        baseCurrencyId: 'token-usd',
        requestedWindow: { kind: 'all', from: '2026-01-01', to: '2026-03-01' },
        effectiveWindow: { from: '2026-01-01', to: '2026-03-01' },
        startValue: '1000',
        endValue: '1235',
        netExternalFlow: '0',
        twr: {
          cumulative: '0.235',
          annualized: null,
          periods: [
            {
              from: '2026-01-01',
              to: '2026-03-01',
              startValue: '1000',
              endValue: '1235',
              netExternalFlow: '0',
              return: '0.235',
              measured: true,
            },
          ],
          measuredPeriods: 1,
          skippedPeriods: 0,
          spanDays: 59,
        },
        attribution: {
          assetReturn: '0.15',
          currencyReturn: '0.0739130434782608695652173913',
          baseReturn: '0.235',
          crossTerm: '0.01108695652173913043478260870',
          attributedPeriods: 1,
          unattributedPeriods: 0,
          unpricedCurrencyPeriods: 0,
          currencies: [{ currencyTokenId: 'token-eur', endWeight: '1' }],
          periods: [
            {
              from: '2026-01-01',
              to: '2026-03-01',
              assetReturn: '0.15',
              currencyReturn: '0.0739130434782608695652173913',
              reason: null,
            },
          ],
        },
        xirr: { status: 'undefined' as const, reason: 'too-few-flows' as const },
        coverage: {
          measuredDays: 2,
          windowDays: 60,
          daysNotFullyCovered: 0,
          skippedPeriods: 0,
          unvaluedFlows: 0,
          staleValuedFlows: 0,
          flowsAfterLastMeasuredDay: 0,
        },
      },
    }),
  } as never);
}

describe('portfolio.getReturns — includePeriods', () => {
  test('omitted by a client: both series are ABSENT, and the scalars are not', async () => {
    stubReturns();
    const result = await makeAuthedCaller(USER).portfolio.getReturns({ window: { kind: 'all' } });

    expect('periods' in (result.returns?.twr as object)).toBe(false);
    expect('periods' in (result.returns?.attribution as object)).toBe(false);
    expect(result.returns?.twr?.cumulative).toBe('0.235');
    expect(result.returns?.twr?.measuredPeriods).toBe(1);
    expect(result.returns?.attribution?.assetReturn).toBe('0.15');
    expect(result.returns?.attribution?.attributedPeriods).toBe(1);
  });

  test('the two legs the screens print compose back to the base figure', async () => {
    // What `ReturnSplit` renders, asserted where it crosses the wire: the
    // three numbers a reader sees have to be the ones that multiply out.
    stubReturns();
    const result = await makeAuthedCaller(USER).portfolio.getReturns({ window: { kind: 'all' } });
    const a = result.returns?.attribution;
    const composed = (1 + Number(a?.assetReturn)) * (1 + Number(a?.currencyReturn)) - 1;
    expect(composed).toBeCloseTo(Number(a?.baseReturn), 12);
  });

  test('asked for: both series travel, over the same boundaries', async () => {
    stubReturns();
    const result = await makeAuthedCaller(USER).portfolio.getReturns({
      window: { kind: 'all' },
      includePeriods: true,
    });

    const twrPeriods = (result.returns?.twr as { periods?: unknown[] }).periods;
    const attributionPeriods = (result.returns?.attribution as { periods?: unknown[] }).periods;
    expect(twrPeriods).toHaveLength(1);
    expect(attributionPeriods).toHaveLength(1);
    // One flag for both is the point: they index the same sub-periods, and a
    // client handed one without the other could not line them up.
    expect((attributionPeriods as Array<{ from: string; to: string }>)[0]).toMatchObject({
      from: '2026-01-01',
      to: '2026-03-01',
    });
  });

  test('an unsplittable return still answers, with attribution null', async () => {
    Container.set(ReturnsService, {
      compute: async () => ({
        status: 'ok' as const,
        returns: {
          scope: { kind: 'user' as const },
          baseCurrencyId: 'token-usd',
          requestedWindow: { kind: 'all', from: '2026-01-01', to: '2026-03-01' },
          effectiveWindow: { from: '2026-01-01', to: '2026-03-01' },
          startValue: '1000',
          endValue: '1200',
          netExternalFlow: '0',
          twr: {
            cumulative: '0.2',
            annualized: null,
            periods: [],
            measuredPeriods: 1,
            skippedPeriods: 0,
            spanDays: 59,
          },
          attribution: null,
          xirr: { status: 'undefined' as const, reason: 'too-few-flows' as const },
          coverage: {
            measuredDays: 2,
            windowDays: 60,
            daysNotFullyCovered: 0,
            skippedPeriods: 0,
            unvaluedFlows: 0,
            staleValuedFlows: 0,
            flowsAfterLastMeasuredDay: 0,
          },
        },
      }),
    } as never);

    const result = await makeAuthedCaller(USER).portfolio.getReturns({ window: { kind: 'all' } });
    expect(result.returns?.attribution).toBeNull();
    expect(result.returns?.twr?.cumulative).toBe('0.2');
  });
});

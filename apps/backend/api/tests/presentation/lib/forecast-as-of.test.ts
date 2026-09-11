/**
 * A production-configured caller cannot move the forecast's clock (SC-623).
 *
 * `payments.forecast` takes an `asOf` so the visual gate can photograph a
 * forecast that does not move with the real date. That input is a hole in
 * production unless three things hold, and each gets its own test because
 * each is a separate layer a later edit could remove:
 *
 * - the ROUTER refuses `asOf` under `NODE_ENV=production`, even with the flag
 *   set — and refuses before it reaches the service, so no forecast is computed
 *   for the day the caller asked about;
 * - it refuses when the flag is off, on any stack;
 * - the api's ENV SCHEMA refuses the flag at boot in production, so a deploy
 *   carrying it does not start.
 *
 * Every refusal is paired with the case that succeeds, because a stub that
 * refused everything would pass all three.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as schema from '@scani/db/schema';
import {
  LiquidAssetsService,
  ObservedBurnService,
  PaymentForecastService,
} from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { Container } from 'typedi';
import {
  FORECAST_AS_OF_ENV,
  resolveForecastAsOf,
} from '../../../src/presentation/lib/forecast-as-of';
import { makeAuthedCaller } from '../../helpers/test-caller';

restoreContainerAfterAll();

const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const AS_OF = '2027-03-04';

function fakeUser(): typeof schema.users.$inferSelect {
  return {
    id: USER_ID,
    email: `${USER_ID}@scani.local`,
    name: 'Test User',
    baseCurrencyId: null,
    image: null,
    emailVerified: false,
    observedBurnOverride: null,
    observedBurnOverrideCurrencyId: null,
    observedBurnOverrideAt: null,
    observedBurnConfirmedValue: null,
    observedBurnConfirmedCurrencyId: null,
    observedBurnConfirmedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as typeof schema.users.$inferSelect;
}

// Bun types `NODE_ENV` read-only; the router reads it per call, so it is set here.
const env = process.env as Record<string, string | undefined>;
const ENV_KEYS = ['NODE_ENV', FORECAST_AS_OF_ENV] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete env[key];
    else env[key] = saved[key];
  }
});

/** What day the service was asked about, per call. `undefined` is "the api's own clock". */
function stubForecast(): { asked: (Date | undefined)[] } {
  const asked: (Date | undefined)[] = [];
  Container.set(PaymentForecastService, {
    forecast: async (_userId: string, asOf?: Date) => {
      asked.push(asOf);
      return {
        movements: [],
        overdue: [],
        unprojectable: [],
        estimatedFromHistory: [],
        today: (asOf ?? new Date()).toISOString().slice(0, 10),
        horizonEnd: '',
        horizonMonths: 12,
      };
    },
  } as unknown as PaymentForecastService);
  Container.set(LiquidAssetsService, {
    getLiquidAssets: async () => ({ amount: '0' }),
  } as unknown as LiquidAssetsService);
  Container.set(ObservedBurnService, {
    observed: async () => {
      throw new Error('must not run: the fake user has no base currency');
    },
  } as unknown as ObservedBurnService);
  return { asked };
}

function setEnv(nodeEnv: string, flag: string | undefined): void {
  env.NODE_ENV = nodeEnv;
  if (flag === undefined) delete env[FORECAST_AS_OF_ENV];
  else env[FORECAST_AS_OF_ENV] = flag;
}

describe('payments.forecast asOf', () => {
  test('production refuses asOf even with the flag set, before the service runs', async () => {
    const { asked } = stubForecast();
    setEnv('production', '1');
    const caller = makeAuthedCaller(fakeUser());
    await expect(caller.payments.forecast({ asOf: AS_OF })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(asked).toEqual([]);
  });

  test('production without asOf still answers, on the api’s own clock', async () => {
    const { asked } = stubForecast();
    setEnv('production', '1');
    const result = await makeAuthedCaller(fakeUser()).payments.forecast();
    expect(asked).toEqual([undefined]);
    expect(result.today).toBe(new Date().toISOString().slice(0, 10));
  });

  test('a non-production stack with the flag off refuses asOf', async () => {
    const { asked } = stubForecast();
    setEnv('development', undefined);
    await expect(
      makeAuthedCaller(fakeUser()).payments.forecast({ asOf: AS_OF })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(asked).toEqual([]);
  });

  test('the control: the e2e stack moves the clock to the day asked for', async () => {
    const { asked } = stubForecast();
    setEnv('development', '1');
    const result = await makeAuthedCaller(fakeUser()).payments.forecast({ asOf: AS_OF });
    expect(asked.map((day) => day?.toISOString())).toEqual(['2027-03-04T00:00:00.000Z']);
    expect(result.today).toBe(AS_OF);
  });

  test('only exactly "1" opens it', () => {
    for (const flag of ['true', 'yes', '0', '']) {
      expect(() =>
        resolveForecastAsOf(AS_OF, { NODE_ENV: 'development', [FORECAST_AS_OF_ENV]: flag })
      ).toThrow('asOf is honoured only');
    }
  });

  test('a malformed date never reaches the resolver', async () => {
    stubForecast();
    setEnv('development', '1');
    await expect(
      makeAuthedCaller(fakeUser()).payments.forecast({ asOf: '2027-3-4' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

/**
 * The boot-time layer. `env.ts` computes `inProd` when it is first imported,
 * so it is exercised in a fresh process, from an empty directory so bun loads
 * no `.env` into it.
 */
describe('the api env schema', () => {
  const ENV_MODULE = join(import.meta.dir, '../../../src/config/env.ts');

  function boot(extra: Record<string, string>): string {
    const result = Bun.spawnSync(
      ['bun', '-e', `import { loadEnv } from ${JSON.stringify(ENV_MODULE)}; loadEnv();`],
      {
        cwd: mkdtempSync(join(tmpdir(), 'forecast-as-of-')),
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...extra },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    return `${result.stdout.toString()}${result.stderr.toString()}`;
  }

  test(`refuses ${FORECAST_AS_OF_ENV} in production`, () => {
    const output = boot({ NODE_ENV: 'production', [FORECAST_AS_OF_ENV]: '1' });
    expect(output).toContain('Invalid environment configuration');
    expect(output).toContain(`- ${FORECAST_AS_OF_ENV}:`);
  });

  test('the control: the same production boot without it does not name it', () => {
    const output = boot({ NODE_ENV: 'production' });
    // Other production variables are missing here too, so the boot still
    // fails — which is what makes this a control on the SAME instrument.
    expect(output).toContain('Invalid environment configuration');
    expect(output).not.toContain(FORECAST_AS_OF_ENV);
  });
});

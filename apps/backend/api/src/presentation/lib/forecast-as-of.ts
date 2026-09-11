import { TRPCError } from '@trpc/server';

/**
 * Who may move the forecast's clock (SC-623).
 *
 * `payments.forecast` dates everything from "today", and on a normal stack
 * that is the api's own clock. The visual gate pins the BROWSER's clock and
 * cannot reach this one, so without an override the "Runs out in <month>"
 * figure and the chart's month axis move with the real date and a baseline of
 * them goes red every month.
 *
 * `asOf` is that override, and it is honoured only where this env var is
 * exactly `'1'` AND the process is not production. The api's env schema also
 * refuses the var at boot in production; this second check is for the case
 * that schema cannot see — a process whose `NODE_ENV` changed after boot, or a
 * caller built without `loadEnv` at all.
 *
 * Supplying `asOf` where it is not honoured is REFUSED rather than ignored. A
 * silently ignored override answers "as of today" to a caller that asked about
 * another day, and nothing in the payload would say which it got.
 */
export const FORECAST_AS_OF_ENV = 'ALLOW_FORECAST_AS_OF';

export function forecastAsOfAllowed(env: Record<string, string | undefined>): boolean {
  return env.NODE_ENV !== 'production' && env[FORECAST_AS_OF_ENV] === '1';
}

/** `undefined` means "the api's own clock". */
export function resolveForecastAsOf(
  asOf: string | undefined,
  env: Record<string, string | undefined>
): Date | undefined {
  if (asOf === undefined) return undefined;
  if (!forecastAsOfAllowed(env)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `asOf is honoured only on a non-production stack with ${FORECAST_AS_OF_ENV}=1`,
    });
  }
  return new Date(`${asOf}T00:00:00Z`);
}

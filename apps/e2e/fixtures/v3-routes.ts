/**
 * Every v3 surface the accessibility gate walks (V3-17).
 *
 * Kept here rather than imported from `apps/frontend/app` because the e2e
 * workspace does not depend on the SPA — but it is not allowed to drift
 * either: `apps/frontend/app/tests/v3/a11y-coverage.test.ts` reads this file
 * and fails when a route in `V3_NAV_PATHS` is missing from it. A new v3
 * surface therefore cannot be shipped past the gate by forgetting to add it.
 *
 * The two entries that are not nav destinations are here because they are the
 * two richest DOM surfaces v3 has: the primitive gallery renders every
 * component in both themes at once, and the payment form is the only screen
 * with a twelve-field form on it.
 */
export const V3_A11Y_ROUTES: readonly string[] = [
  '/',
  '/holdings',
  '/payments',
  '/payments/recurring',
  '/payments/recurring/new',
  '/vendors',
  '/review',
  '/accounts',
  '/institutions',
  '/vaults',
  '/groups',
  '/tokens',
  '/jobs',
  '/documents',
  '/settings',
  '/manual-entry',
  '/kitchen-sink',
];

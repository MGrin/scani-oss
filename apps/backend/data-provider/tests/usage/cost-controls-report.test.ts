import { describe, expect, it } from 'bun:test';
import { describeCostControls } from '../../src/usage/cost-controls-report';

const report = (over: Partial<Parameters<typeof describeCostControls>[0]> = {}) =>
  describeCostControls({
    quotaHourlyDefault: null,
    globalHourlyUsdCap: null,
    cloudManagementEnabled: false,
    ...over,
  });

// WHY THESE ASSERT ON THE SUMMARY TEXT rather than only on the booleans.
//
// The defect this module exists for (SC-582) was not a wrong boolean — the
// two guards in `index.ts` read their env vars correctly the whole time.
// It was that the not-enforcing state produced no output, so an operator
// had nothing to read. A test that checks only `anyDisabled === true`
// would stay green through a change that drops the control out of the
// line, which is the exact regression worth catching.
describe('describeCostControls', () => {
  it('names every non-enforcing control and what goes unbounded', () => {
    const r = report();

    expect(r.anyDisabled).toBe(true);
    expect(r.summary).toContain('0/2 enforcing');
    expect(r.summary).toContain('CLOUD_QUOTA_HOURLY_DEFAULT');
    expect(r.summary).toContain('GLOBAL_HOURLY_USD_CAP');
    expect(r.summary).toContain('unlimited requests');
    expect(r.summary).toContain('bounded only by the provider account');
  });

  it('names the enforcing bounds with their configured values', () => {
    const r = report({ quotaHourlyDefault: 1000, globalHourlyUsdCap: 25.5 });

    expect(r.anyDisabled).toBe(false);
    expect(r.exposed).toBe(false);
    expect(r.summary).toContain('2/2 enforcing');
    expect(r.summary).toContain('CLOUD_QUOTA_HOURLY_DEFAULT=1000 requests/key/hour');
    expect(r.summary).toContain('GLOBAL_HOURLY_USD_CAP=25.5 USD/hour org-wide');
    expect(r.summary).toContain('not enforcing: none');
  });

  // A PARTLY-CONFIGURED DEPLOYMENT: the quota enforcing, the USD cap
  // deliberately at 0. This case is here because it is a shape a reader
  // will meet in a real log, and because "1/2" must never read as
  // "half-configured by accident".
  it('reports one enforcing and one deliberately off as exactly that', () => {
    const r = report({
      quotaHourlyDefault: 1000,
      globalHourlyUsdCap: 0,
      cloudManagementEnabled: true,
    });

    expect(r.summary).toContain('1/2 enforcing');
    expect(r.summary).toContain('CLOUD_QUOTA_HOURLY_DEFAULT=1000 requests/key/hour');
    expect(r.summary).toContain('GLOBAL_HOURLY_USD_CAP off (explicitly 0)');
    expect(r.summary).not.toContain('GLOBAL_HOURLY_USD_CAP unset');
  });

  // AN EXPLICIT 0 AND AN ABSENT VARIABLE ARE DIFFERENT FACTS, and this is
  // the assertion that keeps them different. Collapsing them is what makes
  // a deliberate decision indistinguishable from an oversight — which is
  // how SC-582 came to be filed in the first place, and how it would come
  // to be filed again.
  //
  // This stays meaningful after a cap is eventually set: `unset` is then
  // what a fresh deployment produces, and `off` is what an operator who
  // turned it back off produces. The two still need telling apart.
  it('distinguishes an explicit 0 from an absent variable', () => {
    const off = report({ globalHourlyUsdCap: 0 });
    const unset = report({ globalHourlyUsdCap: null });

    expect(off.summary).toContain('GLOBAL_HOURLY_USD_CAP off (explicitly 0)');
    expect(unset.summary).toContain('GLOBAL_HOURLY_USD_CAP unset');
    expect(off.summary).not.toEqual(unset.summary);

    expect(off.controls.find((c) => c.envVar === 'GLOBAL_HOURLY_USD_CAP')?.state).toBe('off');
    expect(unset.controls.find((c) => c.envVar === 'GLOBAL_HOURLY_USD_CAP')?.state).toBe('unset');

    // Both still disable the breaker — the distinction is in the report,
    // never in the behaviour. `index.ts` installs on `> 0` either way.
    expect(off.anyDisabled).toBe(true);
    expect(unset.anyDisabled).toBe(true);
  });

  it('calls a positive bound enforcing whichever way the other one is set', () => {
    expect(report({ quotaHourlyDefault: 1 }).controls[0]?.state).toBe('enforcing');
    expect(report({ quotaHourlyDefault: 0 }).controls[0]?.state).toBe('off');
    expect(report({ quotaHourlyDefault: null }).controls[0]?.state).toBe('unset');
  });

  // `exposed` is the whole reason the log severity is not a constant: an
  // OSS single-tenant data-provider has no external caller to bound, so an
  // unset cap there is a choice. Only cloud management makes a missing
  // bound reachable by somebody else's API key.
  it('is exposed only when cloud management is on AND a control is not enforcing', () => {
    expect(report({ cloudManagementEnabled: true }).exposed).toBe(true);
    expect(report({ cloudManagementEnabled: false }).exposed).toBe(false);
    expect(
      report({ cloudManagementEnabled: true, quotaHourlyDefault: 10, globalHourlyUsdCap: 1 })
        .exposed
    ).toBe(false);
    // One bound off is still one bound off, whatever the reason, and the
    // line says so on every boot.
    expect(
      report({ cloudManagementEnabled: true, quotaHourlyDefault: 1000, globalHourlyUsdCap: 0 })
        .exposed
    ).toBe(true);
  });

  it('says so in the line when unbounded spend is reachable externally', () => {
    expect(report({ cloudManagementEnabled: true }).summary).toContain(
      'external keys can spend unbounded'
    );
    expect(report({ cloudManagementEnabled: false }).summary).not.toContain(
      'external keys can spend unbounded'
    );
  });
});

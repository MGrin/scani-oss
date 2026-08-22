import { describe, expect, it } from 'bun:test';
import { describeCostControls } from '../../src/usage/cost-controls-report';

const both = (over: Partial<Parameters<typeof describeCostControls>[0]> = {}) =>
  describeCostControls({
    quotaHourlyDefault: 0,
    globalHourlyUsdCap: 0,
    cloudManagementEnabled: false,
    ...over,
  });

// WHY THESE ASSERT ON THE SUMMARY TEXT rather than only on the booleans.
//
// The defect this module exists for (SC-582) was not a wrong boolean — the
// two guards in `index.ts` read their env vars correctly the whole time.
// It was that the DISABLED state produced no output, so an operator had
// nothing to read. A test that checks only `anyDisabled === true` would
// stay green through a change that drops the disabled control out of the
// line, which is the exact regression worth catching.
//
// These stay meaningful after the values are chosen and set in production:
// a real `CLOUD_QUOTA_HOURLY_DEFAULT` makes the first case below the
// non-default one, and the disabled cases are still what a self-hoster,
// a dev stack and a misconfigured redeploy all produce.
describe('describeCostControls', () => {
  it('names every disabled control and what goes unbounded', () => {
    const report = both();

    expect(report.anyDisabled).toBe(true);
    expect(report.summary).toContain('0/2 enforcing');
    expect(report.summary).toContain('CLOUD_QUOTA_HOURLY_DEFAULT');
    expect(report.summary).toContain('GLOBAL_HOURLY_USD_CAP');
    expect(report.summary).toContain('unlimited requests');
    expect(report.summary).toContain('bounded only by the provider account');
  });

  it('names the enforcing bounds with their configured values', () => {
    const report = both({ quotaHourlyDefault: 1000, globalHourlyUsdCap: 25.5 });

    expect(report.anyDisabled).toBe(false);
    expect(report.exposed).toBe(false);
    expect(report.summary).toContain('2/2 enforcing');
    expect(report.summary).toContain('CLOUD_QUOTA_HOURLY_DEFAULT=1000 requests/key/hour');
    expect(report.summary).toContain('GLOBAL_HOURLY_USD_CAP=25.5 USD/hour org-wide');
    expect(report.summary).toContain('disabled: none');
  });

  it('reports a partial configuration as partial rather than as enforcing', () => {
    const report = both({ quotaHourlyDefault: 1000 });

    expect(report.summary).toContain('1/2 enforcing');
    expect(report.controls.find((c) => c.envVar === 'GLOBAL_HOURLY_USD_CAP')?.enforcing).toBe(
      false
    );
  });

  // `exposed` is the whole reason the severity is not a constant: an OSS
  // single-tenant data-provider has no external caller to bound, so an
  // unset cap there is a choice. Only cloud management makes an unset cap
  // reachable by somebody else's API key.
  it('is exposed only when cloud management is on AND a control is off', () => {
    expect(both({ cloudManagementEnabled: true }).exposed).toBe(true);
    expect(both({ cloudManagementEnabled: false }).exposed).toBe(false);
    expect(
      both({ cloudManagementEnabled: true, quotaHourlyDefault: 10, globalHourlyUsdCap: 1 }).exposed
    ).toBe(false);
    expect(both({ cloudManagementEnabled: true, quotaHourlyDefault: 10 }).exposed).toBe(true);
  });

  it('says so in the line when unbounded spend is reachable externally', () => {
    expect(both({ cloudManagementEnabled: true }).summary).toContain(
      'external keys can spend unbounded'
    );
    expect(both({ cloudManagementEnabled: false }).summary).not.toContain(
      'external keys can spend unbounded'
    );
  });

  // A negative value cannot reach here — the zod schema in
  // `config/env.ts` refuses it — but the guard is `> 0` in both places
  // and this pins the two to the same reading.
  it('treats a non-positive bound as disabled', () => {
    expect(
      both({ quotaHourlyDefault: 0, globalHourlyUsdCap: 0 }).controls.every((c) => !c.enforcing)
    ).toBe(true);
  });
});

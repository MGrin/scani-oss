/**
 * Boot-time record of whether the two cloud cost controls are enforcing.
 *
 * WHY THIS EXISTS (SC-582). Both controls are gated on an env var, and
 * both guards in `index.ts` are a bare `if (value > 0) { install() }`. So
 * the ENABLED state used to log a line and the DISABLED state logged
 * nothing — and "nothing" is also what a healthy boot of a service that
 * has no cost controls at all looks like — so a deployment with no
 * ceiling at all is indistinguishable, in its own logs, from a bounded
 * one, and stays that way until somebody reads a provider bill.
 *
 * THE LINE PRINTS ON EVERY BOOT, enforcing or not — the same reasoning as
 * `ProviderCredentialReport` in `@scani/providers`. A line that only
 * appears when things are fine is one nobody has ever seen absent, so
 * nobody notices when it stops appearing. A line that always prints and
 * changes content gets read.
 *
 * THREE STATES, NOT TWO, and the third is the point. `unset` and an
 * explicit `0` both disable a control and are NOT the same fact: an
 * absent bound is a deployment nobody has decided about, an explicit `0`
 * is a decision somebody made. An operator who deliberately declines a
 * dollar cap should be able to tell that apart, six months later, from
 * the oversight this report was written for — and reporting both as
 * "disabled" is what makes the two indistinguishable.
 *
 * This describes CONFIGURATION, not liveness. Whether boot got far enough
 * to install anything is `/ready`'s question, and the deferred-boot IIFE
 * is what answers it.
 */

/** `null` on the two bounds means the variable was absent entirely. */
export interface CostControlsInput {
  quotaHourlyDefault: number | null;
  globalHourlyUsdCap: number | null;
  /**
   * Tier 2/3 only. An OSS single-tenant data-provider has no external
   * callers to meter, so an unset cap there is a configuration choice
   * rather than an exposure — and the severity of the boot line turns on
   * this, not on the bounds alone.
   */
  cloudManagementEnabled: boolean;
}

// Not exported for the same reason as `CostControlStatus` below: it
// travels inside the report and nothing imports it by name.
type CostControlState = 'enforcing' | 'off' | 'unset';

// Not exported: the shape travels as `CostControlsReport['controls']` and
// nothing imports it by name, which `deps:unused` fails the build on.
interface CostControlStatus {
  /** Env var an operator would set, so the report names its own remedy. */
  readonly envVar: string;
  readonly state: CostControlState;
  readonly enforcing: boolean;
  /** Configured bound; `null` when the variable is absent. */
  readonly value: number | null;
  /** Unit the bound is denominated in, for a reader who has neither file open. */
  readonly unit: string;
  /** What goes unbounded while this is not enforcing. */
  readonly unboundedWhenOff: string;
}

export interface CostControlsReport {
  readonly controls: readonly CostControlStatus[];
  readonly cloudManagementEnabled: boolean;
  /** True when at least one control is not enforcing, either way. */
  readonly anyDisabled: boolean;
  /**
   * True when unbounded upstream spend is reachable by an external caller:
   * cloud management on AND a control not enforcing. This is the condition
   * worth a `warn` rather than an `info`.
   */
  readonly exposed: boolean;
  readonly summary: string;
}

function stateOf(value: number | null): CostControlState {
  if (value === null) return 'unset';
  return value > 0 ? 'enforcing' : 'off';
}

export function describeCostControls(input: CostControlsInput): CostControlsReport {
  const controls: CostControlStatus[] = [
    {
      envVar: 'CLOUD_QUOTA_HOURLY_DEFAULT',
      state: stateOf(input.quotaHourlyDefault),
      enforcing: (input.quotaHourlyDefault ?? 0) > 0,
      value: input.quotaHourlyDefault,
      unit: 'requests/key/hour',
      unboundedWhenOff: 'any single API key may issue unlimited requests',
    },
    {
      envVar: 'GLOBAL_HOURLY_USD_CAP',
      state: stateOf(input.globalHourlyUsdCap),
      enforcing: (input.globalHourlyUsdCap ?? 0) > 0,
      value: input.globalHourlyUsdCap,
      unit: 'USD/hour org-wide',
      unboundedWhenOff: 'org-wide upstream spend is bounded only by the provider account',
    },
  ];

  const enforcing = controls.filter((c) => c.enforcing);
  const notEnforcing = controls.filter((c) => !c.enforcing);
  const exposed = input.cloudManagementEnabled && notEnforcing.length > 0;

  const enforcingPart =
    enforcing.length > 0
      ? enforcing.map((c) => `${c.envVar}=${c.value} ${c.unit}`).join(', ')
      : '(none)';
  // `off (explicitly 0)` vs `unset` — the whole reason this report exists
  // in its current shape. Do not collapse these two back into one word.
  const notEnforcingPart =
    notEnforcing.length > 0
      ? notEnforcing
          .map(
            (c) =>
              `${c.envVar} ${c.state === 'off' ? 'off (explicitly 0)' : 'unset'} → ${c.unboundedWhenOff}`
          )
          .join('; ')
      : 'none';

  return {
    controls,
    cloudManagementEnabled: input.cloudManagementEnabled,
    anyDisabled: notEnforcing.length > 0,
    exposed,
    summary:
      `cost controls: ${enforcing.length}/${controls.length} enforcing · ` +
      `enforcing: ${enforcingPart} · not enforcing: ${notEnforcingPart}` +
      (exposed ? ' · CLOUD_MANAGEMENT_ENABLED — external keys can spend unbounded' : ''),
  };
}

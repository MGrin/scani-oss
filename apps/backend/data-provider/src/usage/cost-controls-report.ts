/**
 * Boot-time record of whether the two cloud cost controls are enforcing.
 *
 * WHY THIS EXISTS (SC-582). Both controls are gated on an env var that
 * defaults to `'0'` = disabled, and both guards in `index.ts` are a bare
 * `if (value > 0) { install(); logger.info(...) }` with no else. So the
 * ENABLED state logs a line and the DISABLED state logs nothing — and
 * "nothing" is also what a healthy boot of a service that has no cost
 * controls at all looks like. A deployment that never set either variable
 * is therefore indistinguishable, in its own logs, from one that is fully
 * bounded — and it stays that way until somebody reads a provider bill.
 *
 * THE LINE PRINTS ON EVERY BOOT, enforcing or not — the same reasoning as
 * `ProviderCredentialReport` in `@scani/providers`. A line that only
 * appears when things are fine is one nobody has ever seen absent, so
 * nobody notices when it stops appearing. A line that always prints and
 * changes content gets read.
 *
 * This describes CONFIGURATION, not liveness. Whether boot got far enough
 * to install anything is `/ready`'s question, and the deferred-boot IIFE
 * is what answers it.
 */

// Not exported: the shape travels as `CostControlsReport['controls']` and
// nothing imports it by name, which `deps:unused` fails the build on.
interface CostControlStatus {
  /** Env var an operator would set, so the report names its own remedy. */
  readonly envVar: string;
  readonly enforcing: boolean;
  /** Configured bound. `0` means the control is off. */
  readonly value: number;
  /** Unit the bound is denominated in, for a reader who has neither file open. */
  readonly unit: string;
  /** What goes unbounded while this is off. */
  readonly unboundedWhenOff: string;
}

export interface CostControlsInput {
  quotaHourlyDefault: number;
  globalHourlyUsdCap: number;
  /**
   * Tier 2/3 only. An OSS single-tenant data-provider has no external
   * callers to meter, so an unset cap there is a configuration choice
   * rather than an exposure — and the severity of the boot line turns on
   * this, not on the cap alone.
   */
  cloudManagementEnabled: boolean;
}

export interface CostControlsReport {
  readonly controls: readonly CostControlStatus[];
  readonly cloudManagementEnabled: boolean;
  /** True when at least one control is off. */
  readonly anyDisabled: boolean;
  /**
   * True when unbounded upstream spend is reachable by an external caller:
   * cloud management on AND a control off. This is the condition worth a
   * `warn` rather than an `info`.
   */
  readonly exposed: boolean;
  readonly summary: string;
}

export function describeCostControls(input: CostControlsInput): CostControlsReport {
  const controls: CostControlStatus[] = [
    {
      envVar: 'CLOUD_QUOTA_HOURLY_DEFAULT',
      enforcing: input.quotaHourlyDefault > 0,
      value: input.quotaHourlyDefault,
      unit: 'requests/key/hour',
      unboundedWhenOff: 'any single API key may issue unlimited requests',
    },
    {
      envVar: 'GLOBAL_HOURLY_USD_CAP',
      enforcing: input.globalHourlyUsdCap > 0,
      value: input.globalHourlyUsdCap,
      unit: 'USD/hour org-wide',
      unboundedWhenOff: 'org-wide upstream spend is bounded only by the provider account',
    },
  ];

  const enforcing = controls.filter((c) => c.enforcing);
  const disabled = controls.filter((c) => !c.enforcing);
  const exposed = input.cloudManagementEnabled && disabled.length > 0;

  const enforcingPart =
    enforcing.length > 0
      ? enforcing.map((c) => `${c.envVar}=${c.value} ${c.unit}`).join(', ')
      : '(none)';
  const disabledPart =
    disabled.length > 0
      ? disabled.map((c) => `${c.envVar} unset/0 → ${c.unboundedWhenOff}`).join('; ')
      : 'none';

  return {
    controls,
    cloudManagementEnabled: input.cloudManagementEnabled,
    anyDisabled: disabled.length > 0,
    exposed,
    summary:
      `cost controls: ${enforcing.length}/${controls.length} enforcing · ` +
      `enforcing: ${enforcingPart} · disabled: ${disabledPart}` +
      (exposed ? ' · CLOUD_MANAGEMENT_ENABLED — external keys can spend unbounded' : ''),
  };
}

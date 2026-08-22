/**
 * Boot-time record of which providers resolved a platform credential and
 * which did not.
 *
 * Every provider with a keyless branch reports here from its factory, and
 * `buildProviderRegistry()` emits ONE summary line once every factory has
 * run. `/health/deep` reads the same record, so an operator can answer
 * "which providers came up degraded" without reading a log at all.
 *
 * WHY THIS EXISTS (SC-536). All three backend apps boot
 * `buildProviderRegistry({ mode: 'direct' })`, so each calls these
 * upstreams itself and a missing key degrades that app. None of the
 * keyless branches throws at boot, so the service comes up green and the
 * damage surfaces weeks later as bad data: Finnhub returns null for every
 * equity price — indistinguishable from "no price known" — CoinGecko drops
 * to the public tier, Etherscan goes unauthenticated, OpenAI throws on
 * every screenshot parse.
 *
 * Two of the seven degraded silently even in the logs before this: the
 * CoinGecko and Etherscan factories had no warn at all, so an operator who
 * read every line still could not learn they were unkeyed.
 *
 * THE SUMMARY PRINTS ON A HEALTHY BOOT TOO, naming what IS keyed. A line
 * that only appears when something is wrong is one nobody has ever seen,
 * so nobody notices when it stops appearing; a line that always prints and
 * changes content gets read.
 */

import { Service } from 'typedi';

export interface ProviderCredentialStatus {
  /** Provider key as an operator would name it: `coingecko`, `finnhub`. */
  readonly provider: string;
  /** The environment variable that keys this provider. */
  readonly envVar: string;
  readonly keyed: boolean;
  /**
   * What this provider does when the credential is absent. Recorded
   * whether or not it is keyed, so `/health/deep` can explain the cost of
   * a key that is missing without the reader going to the source.
   */
  readonly degradedBehaviour: string;
}

@Service()
export class ProviderCredentialReport {
  // Keyed by provider so a re-registration (Etherscan builds one provider
  // per chain from a single factory call) records once rather than N times.
  private readonly statuses = new Map<string, ProviderCredentialStatus>();

  record(status: ProviderCredentialStatus): void {
    this.statuses.set(status.provider, status);
  }

  /** Every reporting provider, provider-name ascending for a stable line. */
  all(): ProviderCredentialStatus[] {
    return [...this.statuses.values()].sort((a, b) => a.provider.localeCompare(b.provider));
  }

  keyed(): ProviderCredentialStatus[] {
    return this.all().filter((s) => s.keyed);
  }

  degraded(): ProviderCredentialStatus[] {
    return this.all().filter((s) => !s.keyed);
  }

  /**
   * Reset between boots. `buildProviderRegistry()` calls this before
   * running factories: the report is a typedi singleton and the test suite
   * boots the registry many times in one process, so without it the second
   * boot reports the first boot's providers as well as its own.
   */
  reset(): void {
    this.statuses.clear();
  }

  /**
   * Shape `/health/deep` reports. Deliberately NOT one of that endpoint's
   * `checks`: those gate its 200/503, and a provider without a key is a
   * configuration state rather than an outage. Folding it in would 503
   * every self-host and dev deployment that has not bought a CoinGecko Pro
   * plan, which is how a useful endpoint gets ignored.
   */
  healthPayload(): {
    keyed: string[];
    degraded: { provider: string; envVar: string; behaviour: string }[];
  } {
    return {
      keyed: this.keyed().map((s) => s.provider),
      degraded: this.degraded().map((s) => ({
        provider: s.provider,
        envVar: s.envVar,
        behaviour: s.degradedBehaviour,
      })),
    };
  }

  /**
   * The one line. Always names the keyed set, so its absence is noticeable
   * and a provider silently dropping out of it is visible as a change.
   */
  summary(): string {
    const all = this.all();
    if (all.length === 0) {
      return 'provider credentials: no provider reported a credential status';
    }
    const keyed = this.keyed();
    const degraded = this.degraded();
    const keyedPart =
      keyed.length > 0 ? keyed.map((s) => s.provider).join(', ') : '(none — every key is unset)';
    const degradedPart =
      degraded.length > 0
        ? degraded
            .map((s) => `${s.provider} [${s.envVar} unset → ${s.degradedBehaviour}]`)
            .join('; ')
        : 'none';
    return (
      `provider credentials: ${keyed.length}/${all.length} keyed · ` +
      `keyed: ${keyedPart} · degraded: ${degradedPart}`
    );
  }
}

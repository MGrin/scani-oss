import { describe, expect, it } from 'bun:test';
import type { ProviderFactory, ProviderFactoryDeps } from '../../src/core/boot';
import { CredentialPool } from '../../src/core/credential-pool';
import {
  ProviderCredentialReport,
  type ProviderCredentialStatus,
} from '../../src/core/credential-report';
import { RateLimiterRegistry } from '../../src/core/rate-limiter-registry';
import { aiDeepseekFactory } from '../../src/providers/ai-deepseek';
import { aiOpenAIFactory } from '../../src/providers/ai-openai';
import { aiPerplexityFactory } from '../../src/providers/ai-perplexity';
import { coingeckoFactory } from '../../src/providers/coingecko';
import { etherscanFactory } from '../../src/providers/etherscan';
import { finnhubFactory } from '../../src/providers/finnhub';
import { solanaFactory } from '../../src/providers/solana';

function status(overrides: Partial<ProviderCredentialStatus> = {}): ProviderCredentialStatus {
  return {
    provider: 'finnhub',
    envVar: 'FINNHUB_API_KEY',
    keyed: true,
    degradedBehaviour: 'returns null for every equity price',
    ...overrides,
  };
}

describe('ProviderCredentialReport', () => {
  it('reports the keyed set on a HEALTHY boot, not only on a degraded one', () => {
    // THE LOAD-BEARING TEST. Do not "simplify" this away on the reasoning
    // that a summary is only interesting when something is wrong (SC-536).
    //
    // A line that appears only on failure is one nobody has ever seen, so
    // nobody notices when it stops appearing — and the failure this whole
    // mechanism exists for is precisely the silent one. The keyed line is
    // what makes a provider dropping OUT of the keyed set visible as a
    // change to a reader who has seen the healthy line every deploy.
    const report = new ProviderCredentialReport();
    report.record(status({ provider: 'coingecko', envVar: 'COINGECKO_API_KEY', keyed: true }));
    report.record(status({ provider: 'finnhub', envVar: 'FINNHUB_API_KEY', keyed: true }));

    const summary = report.summary();

    expect(report.degraded()).toHaveLength(0);
    expect(summary).toContain('2/2 keyed');
    expect(summary).toContain('coingecko');
    expect(summary).toContain('finnhub');
    expect(summary).toContain('degraded: none');
  });

  it('names the env var and the consequence for each degraded provider', () => {
    // Asserting the REASON, not just that something was flagged: a bare
    // "degraded is non-empty" assertion survives any change that drops the
    // env var or the behaviour text, which are the two things an operator
    // actually acts on.
    const report = new ProviderCredentialReport();
    report.record(status({ provider: 'coingecko', envVar: 'COINGECKO_API_KEY', keyed: true }));
    report.record(
      status({
        provider: 'finnhub',
        envVar: 'FINNHUB_API_KEY',
        keyed: false,
        degradedBehaviour: 'returns null for every equity price',
      })
    );

    const summary = report.summary();

    expect(summary).toContain('1/2 keyed');
    expect(summary).toContain('FINNHUB_API_KEY unset');
    expect(summary).toContain('returns null for every equity price');
    expect(report.degraded().map((s) => s.provider)).toEqual(['finnhub']);
    expect(report.keyed().map((s) => s.provider)).toEqual(['coingecko']);
  });

  it('says so distinctly when every key is unset', () => {
    const report = new ProviderCredentialReport();
    report.record(status({ provider: 'finnhub', keyed: false }));

    expect(report.summary()).toContain('0/1 keyed');
    expect(report.summary()).toContain('every key is unset');
  });

  it('distinguishes "nothing reported" from "nothing degraded"', () => {
    // A blank report is a report that never ran, not a clean bill of
    // health, and the two must not read alike.
    const report = new ProviderCredentialReport();

    expect(report.summary()).toContain('no provider reported');
    expect(report.summary()).not.toContain('keyed:');
  });

  it('records a provider once however many times its factory reports', () => {
    // Etherscan builds one provider per chain from a single factory call.
    const report = new ProviderCredentialReport();
    report.record(status({ provider: 'etherscan', envVar: 'ETHERSCAN_API_KEY', keyed: false }));
    report.record(status({ provider: 'etherscan', envVar: 'ETHERSCAN_API_KEY', keyed: false }));

    expect(report.all()).toHaveLength(1);
  });

  it('drops the previous boot on reset', () => {
    // The report is a typedi singleton and the suite boots the registry
    // many times in one process; without the reset in
    // `buildProviderRegistry` the second boot reports the first boot's
    // providers alongside its own.
    const report = new ProviderCredentialReport();
    report.record(status({ provider: 'finnhub' }));
    report.reset();
    report.record(status({ provider: 'coingecko', envVar: 'COINGECKO_API_KEY' }));

    expect(report.all().map((s) => s.provider)).toEqual(['coingecko']);
  });

  it('exposes keyed names and degraded detail for /health/deep', () => {
    const report = new ProviderCredentialReport();
    report.record(status({ provider: 'coingecko', envVar: 'COINGECKO_API_KEY', keyed: true }));
    report.record(
      status({
        provider: 'openai',
        envVar: 'OPENAI_API_KEY',
        keyed: false,
        degradedBehaviour: 'throws on every call',
      })
    );

    expect(report.healthPayload()).toEqual({
      keyed: ['coingecko'],
      degraded: [
        { provider: 'openai', envVar: 'OPENAI_API_KEY', behaviour: 'throws on every call' },
      ],
    });
  });
});

/**
 * Every provider with a keyless branch, and the env var that keys it.
 *
 * Seven, not the four SC-536 was filed with: CoinGecko and Etherscan had no
 * boot warning at all before this, so an operator reading every log line
 * still could not learn they had come up unkeyed.
 */
const KEYLESS_BRANCH_FACTORIES: [string, ProviderFactory, string][] = [
  ['coingecko', coingeckoFactory, 'COINGECKO_API_KEY'],
  ['etherscan', etherscanFactory, 'ETHERSCAN_API_KEY'],
  ['finnhub', finnhubFactory, 'FINNHUB_API_KEY'],
  ['solana', solanaFactory, 'HELIUS_API_KEY'],
  ['openai', aiOpenAIFactory, 'OPENAI_API_KEY'],
  ['deepseek', aiDeepseekFactory, 'DEEPSEEK_API_KEY'],
  ['perplexity', aiPerplexityFactory, 'PERPLEXITY_API_KEY'],
];

async function runFactory(
  factory: ProviderFactory,
  env: Record<string, string | undefined>
): Promise<ProviderCredentialStatus[]> {
  // Fresh limiter registry per case: it fails loud on a duplicate
  // namespace, and the shared container's is other suites' state.
  const recorded: ProviderCredentialStatus[] = [];
  const deps: ProviderFactoryDeps = {
    mode: 'direct',
    redis: null,
    env,
    rateLimiterRegistry: new RateLimiterRegistry(),
    credentialPool: new CredentialPool(),
    cloudClient: null,
    reportCredentialStatus: (s) => recorded.push(s),
  };
  await factory(deps);
  return recorded;
}

describe('every provider with a keyless branch reports its credential status', () => {
  for (const [name, factory, envVar] of KEYLESS_BRANCH_FACTORIES) {
    it(`${name} reports degraded when ${envVar} is unset`, async () => {
      const recorded = await runFactory(factory, {});

      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.provider).toBe(name);
      expect(recorded[0]?.envVar).toBe(envVar);
      expect(recorded[0]?.keyed).toBe(false);
      // The behaviour text is what an operator reads to decide whether
      // this matters to them, so an empty one is a failure.
      expect(recorded[0]?.degradedBehaviour.length).toBeGreaterThan(0);
    });

    it(`${name} reports keyed when ${envVar} is set`, async () => {
      // The keyed path is the one a future change is most likely to drop,
      // because nothing visibly breaks when it goes missing — the summary
      // just quietly stops naming this provider.
      const recorded = await runFactory(factory, { [envVar]: 'test-key' });

      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.provider).toBe(name);
      expect(recorded[0]?.keyed).toBe(true);
    });
  }
});

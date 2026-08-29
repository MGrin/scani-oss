/**
 * `EtherscanProvider.probePositions` — the direct question about an asset the
 * caller already knows about, and the three answers it must keep apart
 * (SC-852).
 *
 * `fetchBalances` discovers, and discovery is where the ambiguity comes from:
 * it reads one `tokentx` page and drops every zero, so a token that left the
 * wallet and a token a 429 swallowed are the SAME ABSENCE. Every layer above
 * inherited that, and the refresh told a user their USDC "wasn't returned by
 * the provider — try again in a minute" over a position the chain reports as
 * `0x0`, which is advice that can never come true.
 *
 * So the assertions that matter here are the ones that go APART. A test that
 * only checked `exited` would pass for an implementation that reports every
 * unanswerable call as an exit — which anchors a holding at a zero nobody
 * read, the failure in the other direction.
 */

import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { EtherscanProvider } from '../../src/providers/etherscan';

function passthroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

const WALLET = '0x1111111111111111111111111111111111111111';
const GONE = '0xaaaa000000000000000000000000000000000001';
const STILL_HELD = '0xbbbb000000000000000000000000000000000002';
const UNREADABLE = '0xcccc000000000000000000000000000000000003';

const ctx = {
  institutionCode: 'ethereum',
  baseCurrency: { id: 'usd', symbol: 'USD' } as never,
  credentialsRef: { userId: 'u', institutionId: 'i' },
  resolveCredentials: async () => ({ walletAddress: WALLET }),
};

interface Fixture {
  /** contract (lowercase) → smallest-unit balance string. `native` for ETH. */
  balances?: Record<string, string>;
  /** Contracts whose `tokenbalance` answers `NOTOK`. */
  unreadable?: string[];
  walletAddress?: string;
}

function stubFetch(fixture: Fixture) {
  const original = globalThis.fetch;
  const calls: Array<{ action: string; contract: string | null }> = [];
  globalThis.fetch = (async (input: string) => {
    const url = new URL(String(input));
    const action = url.searchParams.get('action') ?? '';
    const contract = url.searchParams.get('contractaddress');
    calls.push({ action, contract });
    const ok = (result: unknown) =>
      new Response(JSON.stringify({ status: '1', message: 'OK', result }), { status: 200 });

    if (action === 'balance') return ok(fixture.balances?.native ?? '5000000000000000000');
    if (action === 'tokenbalance') {
      const key = (contract ?? '').toLowerCase();
      if (fixture.unreadable?.includes(key)) {
        return new Response(JSON.stringify({ status: '0', message: 'NOTOK', result: 'boom' }), {
          status: 200,
        });
      }
      return ok(fixture.balances?.[key] ?? '1000000000000000000');
    }
    return ok([]);
  }) as unknown as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

async function probe(externalIds: string[], fixture: Fixture = {}) {
  const provider = new EtherscanProvider(
    [
      {
        chainId: 1,
        institutionCode: 'ethereum',
        nativeSymbol: 'ETH',
        nativeName: 'Ethereum',
        nativeDecimals: 18,
      },
    ],
    passthroughLimiter(),
    'key'
  );
  const stub = stubFetch(fixture);
  try {
    const probes = await provider.probePositions(
      {
        ...ctx,
        resolveCredentials: async () => ({
          walletAddress: fixture.walletAddress ?? WALLET,
        }),
      } as never,
      externalIds
    );
    return { probes, calls: stub.calls };
  } finally {
    stub.restore();
  }
}

const stateOf = (probes: Array<{ externalId: string; state: string }>, id: string) =>
  probes.find((p) => p.externalId === id)?.state;

describe('EtherscanProvider.probePositions (SC-852)', () => {
  /**
   * THE CONTROL THE TICKET ASKS FOR, in one call. All three keys are absent
   * from what discovery would have returned — a zero is dropped, an
   * unreadable one never arrives, and the third is only missing because the
   * 10k page did not reach it — and the probe has to give three different
   * answers about them. Asserting any one of these alone passes for an
   * implementation that returns that state unconditionally.
   */
  test('a departed token, a held one and an unreadable one get three answers', async () => {
    const { probes } = await probe([GONE, STILL_HELD, UNREADABLE], {
      balances: { [GONE]: '0', [STILL_HELD]: '250500000' },
      unreadable: [UNREADABLE],
    });

    expect(stateOf(probes, GONE)).toBe('exited');
    expect(stateOf(probes, STILL_HELD)).toBe('held');
    expect(stateOf(probes, UNREADABLE)).toBe('unreadable');
    expect(probes).toHaveLength(3);
  });

  // The scale is never applied, so a token with few decimals whose raw balance
  // is smaller than one whole unit must not round to `exited`. 1 unit of a
  // 6-decimal token is `1`, and `1 / 10^6` truncated is what a naive
  // implementation would call zero.
  test('a dust balance is held, not exited', async () => {
    const { probes } = await probe([STILL_HELD], { balances: { [STILL_HELD]: '1' } });
    expect(stateOf(probes, STILL_HELD)).toBe('held');
  });

  // The native asset goes through the `balance` endpoint, not `tokenbalance` —
  // a wallet that spent all its ETH has no native snapshot either, and routing
  // `'native'` to `tokenbalance` would ask about a contract at address
  // "native" and get an unreadable answer for a position that is genuinely
  // gone.
  test("'native' asks the native endpoint", async () => {
    const { probes, calls } = await probe(['native'], { balances: { native: '0' } });
    expect(stateOf(probes, 'native')).toBe('exited');
    expect(calls.map((c) => c.action)).toEqual(['balance']);
  });

  // The budget claim. `OutflowRateLimiterRegistry` shares one window across
  // every machine, so the population must be the one the caller named and
  // nothing wider — no discovery page, no history walk.
  test('asks exactly once per key and never discovers', async () => {
    const { calls } = await probe([GONE, STILL_HELD], {
      balances: { [GONE]: '0' },
    });
    expect(calls.map((c) => c.action).sort()).toEqual(['tokenbalance', 'tokenbalance']);
    expect(calls.map((c) => c.contract).sort()).toEqual([GONE, STILL_HELD].sort());
  });

  test('an empty request costs no upstream call', async () => {
    const { probes, calls } = await probe([]);
    expect(probes).toEqual([]);
    expect(calls).toEqual([]);
  });

  /**
   * An address the provider cannot even parse answers `unreadable` for every
   * key rather than `[]`. An empty list reads downstream as "nothing to say
   * about these", which is the same silence a working probe over an empty
   * input produces — and a caller that treated the absence of a probe as an
   * exit would anchor holdings at zero on a wallet nobody asked about.
   */
  test('an unparseable address answers unreadable, not silence', async () => {
    const { probes, calls } = await probe([GONE], { walletAddress: 'not-an-address' });
    expect(probes).toEqual([{ externalId: GONE, state: 'unreadable' }]);
    expect(calls).toEqual([]);
  });
});

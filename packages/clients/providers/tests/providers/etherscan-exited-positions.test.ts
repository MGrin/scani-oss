/**
 * `EtherscanProvider.fetchExitedPositions` — the positions a wallet TRADED and
 * no longer holds, which `fetchBalances` cannot see at all (SC-398).
 *
 * The rule itself is unit-tested in `core/base/evm-traded-tokens.test.ts`.
 * What is exercised here is everything BETWEEN the explorer and that rule, and
 * it is where the ticket can still go wrong without a single assertion moving:
 * whether `signedHashes` is built from `txlist.from` rather than `tokentx.from`
 * (the poisoning contract sets the second and cannot set the first), whether a
 * zero-value `Transfer` reaches the movements at all, and whether the balance
 * behind the `'0'` anchor was READ rather than assumed.
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
const ATTACKER = '0x9999999999999999999999999999999999999999';
const GALA = '0xaaaa000000000000000000000000000000000001';
const SPAMC = '0xbbbb000000000000000000000000000000000002';
const FAKEUSDT = '0xcccc000000000000000000000000000000000003';
const HELD = '0xdddd000000000000000000000000000000000004';
const PAID_WITH = '0xeeee000000000000000000000000000000000005';

const ctx = {
  institutionCode: 'ethereum',
  baseCurrency: { id: 'usd', symbol: 'USD' } as never,
  credentialsRef: { userId: 'u', institutionId: 'i' },
  resolveCredentials: async () => ({ walletAddress: WALLET }),
};

interface Fixture {
  txlist?: Array<Record<string, string>>;
  tokentx?: Array<Record<string, string>>;
  /** contract (lowercase) → smallest-unit balance string. `native` for ETH. */
  balances?: Record<string, string>;
  /** Contracts whose `tokenbalance` call fails outright. */
  unreadable?: string[];
}

const nativeRow = (o: Partial<Record<string, string>> = {}) => ({
  blockNumber: '100',
  timeStamp: '1700000000',
  hash: '0xtx',
  from: WALLET,
  to: ATTACKER,
  value: '1000000000000000000',
  gasPrice: '1',
  gasUsed: '1',
  isError: '0',
  txreceipt_status: '1',
  ...o,
});

const tokenRow = (o: Partial<Record<string, string>> = {}) => ({
  blockNumber: '100',
  timeStamp: '1700000000',
  hash: '0xtx',
  from: ATTACKER,
  to: WALLET,
  value: '1000000000000000000',
  contractAddress: GALA,
  tokenName: 'Gala',
  tokenSymbol: 'GALA',
  tokenDecimal: '18',
  ...o,
});

/**
 * Routes on the `action=` in the query string, so the assertions read against
 * the endpoint the provider actually called rather than against call order.
 * A `tokenbalance` for a contract with no fixture entry answers a non-zero
 * balance: the honest default is "still held", so a test that forgets to say
 * a position is closed does not get a free pass.
 */
function stubFetch(fixture: Fixture) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string) => {
    const url = new URL(String(input));
    const action = url.searchParams.get('action') ?? '';
    calls.push(action);
    const ok = (result: unknown, status = '1') =>
      new Response(JSON.stringify({ status, message: 'OK', result }), { status: 200 });

    if (action === 'eth_blockNumber') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x100' }), {
        status: 200,
      });
    }
    if (action === 'txlist') return ok(fixture.txlist ?? []);
    if (action === 'tokentx') return ok(fixture.tokentx ?? []);
    if (action === 'balance') return ok(fixture.balances?.native ?? '5000000000000000000');
    if (action === 'tokenbalance') {
      const contract = (url.searchParams.get('contractaddress') ?? '').toLowerCase();
      if (fixture.unreadable?.includes(contract)) {
        return new Response(JSON.stringify({ status: '0', message: 'NOTOK', result: 'boom' }), {
          status: 200,
        });
      }
      return ok(fixture.balances?.[contract] ?? '1000000000000000000');
    }
    return ok([]);
  }) as unknown as typeof fetch;
  const restore = () => {
    globalThis.fetch = original;
  };
  return { calls, restore };
}

async function run(fixture: Fixture) {
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
    return await provider.fetchExitedPositions(ctx as never);
  } finally {
    stub.restore();
  }
}

describe('EtherscanProvider.fetchExitedPositions', () => {
  // MUST-BE-FOUND, and the acceptance case from the ticket: GALA was bought
  // with 0.05 ETH on 2022-03-28 and fully exited. It has zero rows anywhere in
  // the production ledger today because no holding was ever created for it.
  test('offers a token bought with the wallet’s own ETH and since sold', async () => {
    const out = await run({
      txlist: [nativeRow({ hash: '0xbuy' }), nativeRow({ hash: '0xsell', to: WALLET })],
      tokentx: [
        tokenRow({ hash: '0xbuy' }),
        tokenRow({ hash: '0xsell', from: WALLET, to: ATTACKER }),
      ],
      balances: { [GALA]: '0', native: '5000000000000000000' },
    });
    expect(out.map((p) => p.externalId)).toEqual([GALA]);
    expect(out[0]?.tokenIdentity).toEqual({
      symbol: 'GALA',
      name: 'Gala',
      decimals: 18,
      providerMetadata: { etherscan: { chainId: 1, contractAddress: GALA } },
    });
  });

  // MUST-BE-ABSENT, and the whole reason the balance is not the discriminator:
  // an unsolicited arrival with a zero balance looks exactly like an exited
  // position until you ask who signed.
  test('refuses a token that only ever arrived, however empty', async () => {
    const out = await run({
      txlist: [],
      tokentx: [tokenRow({ contractAddress: SPAMC, tokenSymbol: 'FREE', tokenName: 'Free' })],
      balances: { [SPAMC]: '0' },
    });
    expect(out).toEqual([]);
  });

  // The attack the signature exists for. `tokentx.from` IS the wallet — that
  // is the whole point of address poisoning — and the transaction appears in
  // no `txlist` row of the wallet's, because the attacker signed it. A
  // predicate reading the token stream's `from` as authorisation would admit
  // this; one reading `txlist.from` cannot.
  test('refuses an address-poisoning outflow the wallet never signed', async () => {
    const out = await run({
      txlist: [],
      tokentx: [
        tokenRow({
          hash: '0xpoison',
          from: WALLET,
          to: ATTACKER,
          contractAddress: FAKEUSDT,
          tokenSymbol: 'USDT',
          tokenName: 'Tether USD',
        }),
      ],
      balances: { [FAKEUSDT]: '0' },
    });
    expect(out).toEqual([]);
  });

  // The control for the two above: the SAME leg, with the wallet's signature
  // on the transaction, IS offered. Without it a `fetchExitedPositions` that
  // always returned `[]` would pass both refusals.
  test('the signature is the difference — the same leg, signed, IS offered', async () => {
    const out = await run({
      txlist: [nativeRow({ hash: '0xpoison', value: '0' })],
      tokentx: [
        tokenRow({
          hash: '0xpoison',
          from: WALLET,
          to: ATTACKER,
          contractAddress: FAKEUSDT,
          tokenSymbol: 'USDT',
          tokenName: 'Tether USD',
        }),
      ],
      balances: { [FAKEUSDT]: '0' },
    });
    expect(out.map((p) => p.externalId)).toEqual([FAKEUSDT]);
  });

  // SC-764, END TO END. One poisoning contract emitting BOTH legs in ONE
  // transaction the wallet never signed. The outbound leg is what puts the
  // hash in `paidHashes`, so the inbound leg read as "bought, paying with
  // itself" and the token was offered as a closed position.
  test('refuses an in-and-out pair from one contract in an unsigned transaction', async () => {
    const out = await run({
      txlist: [],
      tokentx: [
        tokenRow({
          hash: '0xpair',
          from: ATTACKER,
          to: WALLET,
          contractAddress: FAKEUSDT,
          tokenSymbol: 'USDT',
          tokenName: 'Tether USD',
        }),
        tokenRow({
          hash: '0xpair',
          from: WALLET,
          to: ATTACKER,
          contractAddress: FAKEUSDT,
          tokenSymbol: 'USDT',
          tokenName: 'Tether USD',
        }),
      ],
      balances: { [FAKEUSDT]: '0' },
    });
    expect(out).toEqual([]);
  });

  // THE CONTROL, and it is the arm that fails if the refusal above is ever
  // reached by requiring a signature instead. Same absence of any `txlist` row
  // — which is what a Safe, an ERC-4337 account or a solver-submitted swap
  // looks like, since only an EOA can be a transaction's `from` — but the
  // wallet gave up a DIFFERENT token to get this one. That is a purchase and
  // it has to survive.
  test('offers a token bought with another token in a transaction the wallet did not sign', async () => {
    const out = await run({
      txlist: [],
      tokentx: [
        tokenRow({
          hash: '0xswap',
          from: WALLET,
          to: ATTACKER,
          contractAddress: PAID_WITH,
          tokenSymbol: 'PAYC',
          tokenName: 'Payment Coin',
        }),
        tokenRow({ hash: '0xswap', from: ATTACKER, to: WALLET, contractAddress: GALA }),
      ],
      balances: { [GALA]: '0' },
    });
    expect(out.map((p) => p.externalId)).toEqual([GALA]);
  });

  // A zero-value `Transfer` is not a transfer (SC-348). It must not count as a
  // movement here either, or the poisoning variant that spoofs a zero-value
  // log would re-enter through this door.
  test('a zero-value leg is not a movement', async () => {
    const out = await run({
      txlist: [nativeRow({ hash: '0xz' })],
      tokentx: [tokenRow({ hash: '0xz', value: '0', contractAddress: SPAMC })],
      balances: { [SPAMC]: '0' },
    });
    expect(out).toEqual([]);
  });

  // THE ZERO IS MEASURED. `holdings.balance` is an anchor rather than a sum,
  // so a position reported closed while the wallet still holds some would put
  // a wrong number on a screen and reconstruct the history backwards from it.
  test('a traded token the wallet still holds is NOT offered as closed', async () => {
    const out = await run({
      txlist: [nativeRow({ hash: '0xbuy' })],
      tokentx: [tokenRow({ hash: '0xbuy', contractAddress: HELD, tokenSymbol: 'HELD' })],
      balances: { [HELD]: '4200000000000000000' },
    });
    expect(out).toEqual([]);
  });

  // "Could not read" is not "zero" — the third state `fetchNativeBalance` and
  // the discovery loop both collapse, correctly, because neither produces a
  // snapshot either way. Here the two answers differ.
  test('an unreadable balance drops the candidate rather than anchoring it at zero', async () => {
    const out = await run({
      txlist: [nativeRow({ hash: '0xbuy' })],
      tokentx: [tokenRow({ hash: '0xbuy', contractAddress: HELD })],
      unreadable: [HELD],
    });
    expect(out).toEqual([]);
  });

  // The native asset has the same defect and the same cure: a wallet that
  // spent all of its ETH gets no native snapshot, so its native legs are
  // dropped exactly as an exited ERC-20's are.
  test('offers the native asset when the wallet spent all of it', async () => {
    const out = await run({
      txlist: [nativeRow({ hash: '0xspend' })],
      tokentx: [],
      balances: { native: '0' },
    });
    expect(out.map((p) => p.externalId)).toEqual(['native']);
    expect(out[0]?.tokenIdentity.symbol).toBe('ETH');
  });

  test('does not offer the native asset while the wallet still holds some', async () => {
    const out = await run({
      txlist: [nativeRow({ hash: '0xspend' })],
      tokentx: [],
      balances: { native: '5000000000000000000' },
    });
    expect(out).toEqual([]);
  });

  // Agreeing with `fetchErc20Balances`' name filter is what keeps the two
  // lists comparable. A token this admits and that drops would be offered at
  // zero while the wallet still held some.
  test('applies the same name filter the balance discovery does', async () => {
    const out = await run({
      txlist: [nativeRow({ hash: '0xbuy' })],
      tokentx: [
        tokenRow({
          hash: '0xbuy',
          contractAddress: SPAMC,
          tokenSymbol: 'CLAIM',
          tokenName: 'Claim 5000 USDT at t.me/x',
        }),
      ],
      balances: { [SPAMC]: '0' },
    });
    expect(out).toEqual([]);
  });

  test('an empty history offers nothing and asks for no balances', async () => {
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
    const stub = stubFetch({ txlist: [], tokentx: [] });
    try {
      expect(await provider.fetchExitedPositions(ctx as never)).toEqual([]);
      expect(stub.calls).not.toContain('tokenbalance');
      expect(stub.calls).not.toContain('balance');
      // The denominator: the walk did happen. Without this the assertions
      // above are equally satisfied by a method that returned early.
      expect(stub.calls).toContain('txlist');
      expect(stub.calls).toContain('tokentx');
    } finally {
      stub.restore();
    }
  });
});

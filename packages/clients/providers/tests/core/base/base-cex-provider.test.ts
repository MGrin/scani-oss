import { describe, expect, test } from 'bun:test';
import {
  BaseCexProvider,
  type CexNormalizedEvent,
  type CexWalkVerdict,
} from '../../../src/core/base/base-cex-provider';
import type { Capability } from '../../../src/core/capabilities';
import { createMockSelfCredContext } from '../../../src/core/testing';
import type {
  ProviderContext,
  TokenIdentity,
  TransactionEvent,
  TransactionFetchContext,
  WithUserCreds,
} from '../../../src/core/types';

// Minimal subclass: stubbable history generator + identity map. Lets the
// base's pagination + sign-enforcement + counter/fee inference run as
// they would in production without per-venue noise.
class TestCexProvider extends BaseCexProvider {
  readonly providerKey = 'test-cex';
  readonly capabilities: readonly Capability[] = ['transactions'];

  constructor(
    private readonly events: readonly CexNormalizedEvent[],
    private readonly identityMap: Record<string, TokenIdentity | null>,
    /**
     * `null` models a subclass that forgets to return a verdict. Not
     * `undefined`: an explicit `undefined` argument takes the default,
     * which would silently turn that test into a second copy of the
     * complete-history one.
     */
    private readonly verdict: CexWalkVerdict | null = { hasCompleteTxHistory: true }
  ) {
    super();
  }

  protected mapAssetIdentity(assetCode: string): TokenIdentity | null {
    return this.identityMap[assetCode] ?? null;
  }

  protected async *fetchHistoryPaginated(
    _ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): AsyncGenerator<CexNormalizedEvent, CexWalkVerdict, void> {
    for (const e of this.events) yield e;
    // `as` rather than a non-null assertion: the point of the `undefined`
    // case is a subclass whose runtime value does not match its signature,
    // which is precisely what a JavaScript generator with a bare `return`
    // produces.
    return this.verdict as unknown as CexWalkVerdict;
  }

  // Public hook so tests don't have to bracket-access protected method.
  async runFetchTransactions(ctx: TransactionFetchContext): Promise<TransactionEvent[]> {
    return this.fetchTransactionsViaPagination(ctx);
  }
}

const BTC: TokenIdentity = { symbol: 'BTC', name: 'Bitcoin', decimals: 8 };
const USDT: TokenIdentity = { symbol: 'USDT', name: 'Tether', decimals: 6 };
const USD: TokenIdentity = { symbol: 'USD', name: 'US Dollar', decimals: 2 };

function ctx() {
  return createMockSelfCredContext({
    credentials: { apiKey: 'k', apiSecret: 's' },
    institutionId: 'inst',
  }) as WithUserCreds<ProviderContext> & { institutionCode: string };
}

/** A context that records every retraction, the way `TransactionRouter` does. */
function recordingCtx(): TransactionFetchContext & { retractions: string[] } {
  const retractions: string[] = [];
  return {
    ...ctx(),
    institutionCode: 'kraken',
    retractions,
    retractHistoryClaim: (reason: string) => {
      retractions.push(reason);
    },
  };
}

/**
 * The walk's verdict reaches the caller (SC-395).
 *
 * Every CEX paginator's terminal value was discarded by the drain loop —
 * `if (step.done) break` never looked at `step.value` — so Kraken could
 * measure that its ledger contradicted itself and the coverage row went on
 * claiming a complete history anyway. These assert the channel, and the
 * `true` case is the negative control: a guard that fires on every walk
 * would retract every claim and be indistinguishable from deleting the
 * flag.
 */
describe('BaseCexProvider — the paginator retracts through the caller', () => {
  const event: CexNormalizedEvent = {
    kind: 'buy',
    assetCode: 'BTC',
    quantity: '1',
    occurredAt: new Date('2024-01-01'),
    externalId: 'buy-1',
  };

  test('a false verdict retracts, carrying the paginator own reason', async () => {
    const provider = new TestCexProvider(
      [event],
      { BTC },
      {
        hasCompleteTxHistory: false,
        reason: 'test-cex: the ledger contradicts itself over 492 entries',
      }
    );
    const c = recordingCtx();

    const events = await provider.runFetchTransactions(c);

    expect(events).toHaveLength(1);
    expect(c.retractions).toEqual(['test-cex: the ledger contradicts itself over 492 entries']);
  });

  test('a true verdict retracts nothing', async () => {
    const provider = new TestCexProvider([event], { BTC }, { hasCompleteTxHistory: true });
    const c = recordingCtx();

    await provider.runFetchTransactions(c);

    expect(c.retractions).toEqual([]);
  });

  test('a paginator that returns no verdict at all retracts, and says it was absent', async () => {
    const provider = new TestCexProvider([event], { BTC }, null);
    const c = recordingCtx();

    await provider.runFetchTransactions(c);

    expect(c.retractions).toHaveLength(1);
    expect(c.retractions[0]).toContain('did not confirm');
  });

  test("a false verdict with no reason still retracts, under the base's own words", async () => {
    const provider = new TestCexProvider([event], { BTC }, { hasCompleteTxHistory: false });
    const c = recordingCtx();

    await provider.runFetchTransactions(c);

    expect(c.retractions).toHaveLength(1);
    expect(c.retractions[0]).toContain('test-cex');
  });

  // A provider is not required to be handed a sink — provider tests and the
  // cloud fetcher build their own contexts — so a partial walk against a
  // context without one must not throw. Without the `?.` this is a crash on
  // the exact path that already knows something is wrong.
  test('a partial walk against a context with no sink does not throw', async () => {
    const provider = new TestCexProvider([event], { BTC }, { hasCompleteTxHistory: false });

    const events = await provider.runFetchTransactions({ ...ctx(), institutionCode: 'kraken' });

    expect(events).toHaveLength(1);
  });
});

describe('BaseCexProvider — sign enforcement', () => {
  test('sell with positive raw quantity flips to negative', async () => {
    const provider = new TestCexProvider(
      [
        {
          kind: 'sell',
          assetCode: 'BTC',
          quantity: '1.5',
          occurredAt: new Date('2024-01-01'),
          externalId: 'sell-1',
        },
      ],
      { BTC }
    );
    const events = await provider.runFetchTransactions({ ...ctx(), institutionCode: 'kraken' });
    expect(events).toHaveLength(1);
    expect(events[0]?.primary.quantity).toBe('-1.5');
    expect(events[0]?.kind).toBe('sell');
  });

  test('buy with negative raw quantity flips to positive', async () => {
    const provider = new TestCexProvider(
      [
        {
          kind: 'buy',
          assetCode: 'BTC',
          quantity: '-2.0',
          occurredAt: new Date('2024-01-01'),
          externalId: 'buy-1',
        },
      ],
      { BTC }
    );
    const events = await provider.runFetchTransactions({ ...ctx(), institutionCode: 'kraken' });
    expect(events[0]?.primary.quantity).toBe('2');
  });

  test('withdraw with positive raw quantity flips to negative', async () => {
    const provider = new TestCexProvider(
      [
        {
          kind: 'withdraw',
          assetCode: 'BTC',
          quantity: '0.25',
          occurredAt: new Date('2024-01-01'),
          externalId: 'wd-1',
        },
      ],
      { BTC }
    );
    const events = await provider.runFetchTransactions({ ...ctx(), institutionCode: 'kraken' });
    expect(events[0]?.primary.quantity).toBe('-0.25');
  });

  test('deposit/reward/interest with already-positive quantity stays positive', async () => {
    const provider = new TestCexProvider(
      [
        {
          kind: 'deposit',
          assetCode: 'BTC',
          quantity: '1',
          occurredAt: new Date('2024-01-01'),
          externalId: 'd-1',
        },
        {
          kind: 'reward',
          assetCode: 'BTC',
          quantity: '0.01',
          occurredAt: new Date('2024-01-02'),
          externalId: 'r-1',
        },
        {
          kind: 'interest',
          assetCode: 'BTC',
          quantity: '0.001',
          occurredAt: new Date('2024-01-03'),
          externalId: 'i-1',
        },
      ],
      { BTC }
    );
    const events = await provider.runFetchTransactions({ ...ctx(), institutionCode: 'kraken' });
    expect(events.map((e) => e.primary.quantity)).toEqual(['1', '0.01', '0.001']);
  });

  test('zero-quantity event is preserved (no flip)', async () => {
    const provider = new TestCexProvider(
      [
        {
          kind: 'sell',
          assetCode: 'BTC',
          quantity: '0',
          occurredAt: new Date('2024-01-01'),
          externalId: 'z-1',
        },
      ],
      { BTC }
    );
    const events = await provider.runFetchTransactions({ ...ctx(), institutionCode: 'kraken' });
    expect(events[0]?.primary.quantity).toBe('0');
  });
});

describe('BaseCexProvider — asset identity mapping', () => {
  test('events with unknown asset are skipped (warning, no throw)', async () => {
    const provider = new TestCexProvider(
      [
        {
          kind: 'buy',
          assetCode: 'UNKNOWN',
          quantity: '1',
          occurredAt: new Date('2024-01-01'),
          externalId: 'u-1',
        },
        {
          kind: 'buy',
          assetCode: 'BTC',
          quantity: '2',
          occurredAt: new Date('2024-01-02'),
          externalId: 'b-1',
        },
      ],
      { BTC, UNKNOWN: null }
    );
    const events = await provider.runFetchTransactions({ ...ctx(), institutionCode: 'kraken' });
    expect(events).toHaveLength(1);
    expect(events[0]?.externalId).toBe('b-1');
  });

  test('primary asset mapping flows through to TransactionEvent.primary.tokenIdentity', async () => {
    const provider = new TestCexProvider(
      [
        {
          kind: 'buy',
          assetCode: 'BTC',
          quantity: '1',
          occurredAt: new Date('2024-01-01'),
          externalId: 'b-1',
        },
      ],
      { BTC }
    );
    const events = await provider.runFetchTransactions({ ...ctx(), institutionCode: 'kraken' });
    expect(events[0]?.primary.tokenIdentity).toEqual(BTC);
  });
});

describe('BaseCexProvider — counter quantity sign inference', () => {
  test('buy primary positive → counter negative (you spent USDT to buy BTC)', async () => {
    const provider = new TestCexProvider(
      [
        {
          kind: 'buy',
          assetCode: 'BTC',
          quantity: '1.0',
          counterAssetCode: 'USDT',
          counterQuantity: '40000',
          occurredAt: new Date('2024-01-01'),
          externalId: 't-1',
        },
      ],
      { BTC, USDT }
    );
    const events = await provider.runFetchTransactions({ ...ctx(), institutionCode: 'kraken' });
    expect(events[0]?.primary.quantity).toBe('1');
    expect(events[0]?.counter?.quantity).toBe('-40000');
    expect(events[0]?.counter?.tokenIdentity).toEqual(USDT);
  });

  test('sell primary negative → counter positive (you received USDT for selling BTC)', async () => {
    const provider = new TestCexProvider(
      [
        {
          kind: 'sell',
          assetCode: 'BTC',
          quantity: '1.0',
          counterAssetCode: 'USDT',
          counterQuantity: '42000',
          occurredAt: new Date('2024-01-01'),
          externalId: 't-2',
        },
      ],
      { BTC, USDT }
    );
    const events = await provider.runFetchTransactions({ ...ctx(), institutionCode: 'kraken' });
    expect(events[0]?.primary.quantity).toBe('-1');
    expect(events[0]?.counter?.quantity).toBe('42000');
  });

  test('counter asset unknown → counter omitted (event still emitted)', async () => {
    const provider = new TestCexProvider(
      [
        {
          kind: 'buy',
          assetCode: 'BTC',
          quantity: '1',
          counterAssetCode: 'UNKNOWN',
          counterQuantity: '40000',
          occurredAt: new Date('2024-01-01'),
          externalId: 't-3',
        },
      ],
      { BTC, UNKNOWN: null }
    );
    const events = await provider.runFetchTransactions({ ...ctx(), institutionCode: 'kraken' });
    expect(events).toHaveLength(1);
    expect(events[0]?.counter).toBeUndefined();
  });

  test('absolute counter quantity is normalized regardless of incoming sign', async () => {
    const provider = new TestCexProvider(
      [
        {
          kind: 'buy',
          assetCode: 'BTC',
          quantity: '1',
          counterAssetCode: 'USDT',
          counterQuantity: '-40000', // already-negative input
          occurredAt: new Date('2024-01-01'),
          externalId: 't-4',
        },
      ],
      { BTC, USDT }
    );
    const events = await provider.runFetchTransactions({ ...ctx(), institutionCode: 'kraken' });
    // primary positive → counter must be negative; abs() then negate.
    expect(events[0]?.counter?.quantity).toBe('-40000');
  });
});

describe('BaseCexProvider — fee handling', () => {
  test('fee with positive input is negated (fee always flows out)', async () => {
    const provider = new TestCexProvider(
      [
        {
          kind: 'buy',
          assetCode: 'BTC',
          quantity: '1',
          feeAssetCode: 'USDT',
          feeQuantity: '5',
          occurredAt: new Date('2024-01-01'),
          externalId: 'f-1',
        },
      ],
      { BTC, USDT }
    );
    const events = await provider.runFetchTransactions({ ...ctx(), institutionCode: 'kraken' });
    expect(events[0]?.fee?.quantity).toBe('-5');
    expect(events[0]?.fee?.tokenIdentity).toEqual(USDT);
  });

  test('fee with negative input is also normalized to negative (abs then negate)', async () => {
    const provider = new TestCexProvider(
      [
        {
          kind: 'buy',
          assetCode: 'BTC',
          quantity: '1',
          feeAssetCode: 'USDT',
          feeQuantity: '-5', // already-negative input
          occurredAt: new Date('2024-01-01'),
          externalId: 'f-2',
        },
      ],
      { BTC, USDT }
    );
    const events = await provider.runFetchTransactions({ ...ctx(), institutionCode: 'kraken' });
    expect(events[0]?.fee?.quantity).toBe('-5');
  });

  test('fee asset unknown → fee omitted', async () => {
    const provider = new TestCexProvider(
      [
        {
          kind: 'buy',
          assetCode: 'BTC',
          quantity: '1',
          feeAssetCode: 'UNKNOWN',
          feeQuantity: '5',
          occurredAt: new Date('2024-01-01'),
          externalId: 'f-3',
        },
      ],
      { BTC, UNKNOWN: null }
    );
    const events = await provider.runFetchTransactions({ ...ctx(), institutionCode: 'kraken' });
    expect(events[0]?.fee).toBeUndefined();
  });
});

describe('BaseCexProvider — priceNative passthrough', () => {
  test('priceNative + priceNativeAssetCode populates priceNative on event', async () => {
    const provider = new TestCexProvider(
      [
        {
          kind: 'buy',
          assetCode: 'BTC',
          quantity: '1',
          priceNative: '40000',
          priceNativeAssetCode: 'USD',
          occurredAt: new Date('2024-01-01'),
          externalId: 'p-1',
        },
      ],
      { BTC, USD }
    );
    const events = await provider.runFetchTransactions({ ...ctx(), institutionCode: 'kraken' });
    expect(events[0]?.priceNative).toEqual({ value: '40000', quoteIdentity: USD });
  });

  test('priceNative without quote-asset code → priceNative omitted', async () => {
    const provider = new TestCexProvider(
      [
        {
          kind: 'buy',
          assetCode: 'BTC',
          quantity: '1',
          priceNative: '40000',
          // priceNativeAssetCode missing
          occurredAt: new Date('2024-01-01'),
          externalId: 'p-2',
        },
      ],
      { BTC }
    );
    const events = await provider.runFetchTransactions({ ...ctx(), institutionCode: 'kraken' });
    expect(events[0]?.priceNative).toBeUndefined();
  });
});

describe('BaseCexProvider — generator iteration', () => {
  test('all events are pulled from the generator (page-by-page semantics work)', async () => {
    const events = Array.from({ length: 50 }, (_, i) => ({
      kind: 'buy' as const,
      assetCode: 'BTC',
      quantity: '1',
      occurredAt: new Date(`2024-01-${String((i % 28) + 1).padStart(2, '0')}`),
      externalId: `e-${i}`,
    }));
    const provider = new TestCexProvider(events, { BTC });
    const out = await provider.runFetchTransactions({ ...ctx(), institutionCode: 'kraken' });
    expect(out).toHaveLength(50);
  });

  test('rawPayload is preserved on the emitted event', async () => {
    const provider = new TestCexProvider(
      [
        {
          kind: 'buy',
          assetCode: 'BTC',
          quantity: '1',
          occurredAt: new Date('2024-01-01'),
          externalId: 'rp-1',
          rawPayload: { kraken_specific: { ledger_id: 'LXXX' } },
        },
      ],
      { BTC }
    );
    const events = await provider.runFetchTransactions({ ...ctx(), institutionCode: 'kraken' });
    expect(events[0]?.rawPayload).toEqual({ kraken_specific: { ledger_id: 'LXXX' } });
  });
});

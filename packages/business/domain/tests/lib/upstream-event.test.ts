/**
 * The two decisions behind unpicking a same-holding transfer group (SC-347).
 *
 * The Kraken case carries the weight. Reading the event id out of
 * `external_id` — which is what every previous measurement of this population
 * did — silently reclassifies 22 real single-operation groups as artifacts, and
 * unlinking one rewrites its cost basis at that day's market price. So the
 * negative direction is the one tested hardest: `sameHoldingGroupVerdict` must refuse on
 * anything short of positive evidence that two events happened.
 */

import { describe, expect, test } from 'bun:test';
import { sameHoldingGroupVerdict, upstreamEventKey } from '../../src/lib/upstream-event';

describe('upstreamEventKey', () => {
  test('reads the EVM transaction hash from the payload', () => {
    expect(upstreamEventKey('etherscan', '0xABC-0x3', { hash: '0xABC', to: '0xdead' })).toBe(
      '0xabc'
    );
  });

  test('falls back to the hash leading the external_id, via txHashFromPayload', () => {
    // The two production EVM legs of one group differ only in the log index
    // suffix. Delegating rather than re-deriving is deliberate: a second copy
    // of "where the hash lives" is a second copy that drifts, which is the
    // exact defect SC-347 fixed one layer up.
    const hash = `0x${'ab'.repeat(32)}`;
    expect(upstreamEventKey('etherscan', `${hash}-0x3`, null)).toBe(hash);
    expect(upstreamEventKey('etherscan', `${hash}-0x1`, {})).toBe(hash);
  });

  test('reads Kraken’s refid, NOT its per-entry ledger id', () => {
    // The two legs of one Kraken operation carry different `external_id`s —
    ***REMOVED***
    ***REMOVED***
    // artifacts.
    ***REMOVED***
      ***REMOVED***
      subtype: 'autoallocation',
    });
    ***REMOVED***
      ***REMOVED***
      subtype: 'autoallocation',
    });
    ***REMOVED***
    expect(withdraw).toBe(deposit);
  });

  test('reads a Solana signature off the external_id, ignoring the leg index', () => {
    const sig = '41aodWRtheFk9YmWuboJWiAGX4kHnpy7boAmZiY6KA2BNiHH34rKsa4s2RuhSNtiR2hwgE';
    // Solana rows carry no raw_payload at all in production, which is why the
    // signature has to come from the id.
    expect(upstreamEventKey('solana', `${sig}-native-4`, null)).toBe(sig.toLowerCase());
    expect(upstreamEventKey('solana', `${sig}-native-0`, null)).toBe(sig.toLowerCase());
  });

  test('is null for a source it cannot read, and for a missing id', () => {
    expect(upstreamEventKey('binance-api', 'whatever', { id: 7 })).toBeNull();
    expect(upstreamEventKey('etherscan', '0xABC-0x3', {})).toBeNull();
    expect(upstreamEventKey('kraken-api', 'L-1', { refid: '  ' })).toBeNull();
    expect(upstreamEventKey('etherscan', '0xABC-0x3', null)).toBeNull();
  });
});

describe('sameHoldingGroupVerdict', () => {
  const leg = (
    over: Partial<{ eventKey: string | null; source: string; holdingId: string }> = {}
  ) => ({
    eventKey: '0xaaa',
    source: 'etherscan',
    holdingId: 'holding-a',
    ...over,
  });

  test('unlinks two different upstream events on one holding', () => {
    expect(sameHoldingGroupVerdict([leg(), leg({ eventKey: '0xbbb' })]).unlink).toBe(true);
  });

  test('keeps one upstream event — the group is a real no-op', () => {
    expect(sameHoldingGroupVerdict([leg(), leg()]).unlink).toBe(false);
  });

  test('keeps a Kraken autoallocation pair, which is the 22-group cluster', () => {
    const refid = 'elc3mxj-ghejb-n6wf7c';
    const verdict = sameHoldingGroupVerdict([
      leg({ source: 'kraken-api', eventKey: refid }),
      leg({ source: 'kraken-api', eventKey: refid }),
    ]);
    expect(verdict.unlink).toBe(false);
    expect(verdict.reason).toContain('one upstream event');
  });

  test('keeps a group whose source carries no event id — unreadable is not proven', () => {
    const verdict = sameHoldingGroupVerdict([
      leg({ source: 'binance-api', eventKey: null }),
      leg({ source: 'binance-api', eventKey: null }),
    ]);
    expect(verdict.unlink).toBe(false);
    expect(verdict.reason).toContain('no event id');
  });

  test('keeps a group whose legs come from two sources — the ids are not comparable', () => {
    expect(
      sameHoldingGroupVerdict([
        leg({ source: 'kraken-api', eventKey: 'abc' }),
        leg({ source: 'etherscan', eventKey: '0xdef' }),
      ]).unlink
    ).toBe(false);
  });

  test('keeps a group that spans two holdings — that is a real move', () => {
    expect(
      sameHoldingGroupVerdict([leg(), leg({ holdingId: 'holding-b', eventKey: '0xbbb' })]).unlink
    ).toBe(false);
  });

  test('keeps a lone leg', () => {
    expect(sameHoldingGroupVerdict([leg()]).unlink).toBe(false);
  });
});

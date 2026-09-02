import { describe, expect, test } from 'bun:test';
import {
  classifyDrop,
  isTradedPosition,
  type TokenMovements,
} from '../../../src/core/base/evm-traded-tokens';

const movements = (o: Partial<TokenMovements> = {}): TokenMovements => ({
  inflowHashes: [],
  outflowHashes: [],
  signedHashes: new Set<string>(),
  paidHashes: new Set<string>(),
  ...o,
});

describe('isTradedPosition — what the wallet review may offer (SC-398)', () => {
  // MUST-BE-FOUND, and this is mgrin's stated acceptance case: PUNKS, GALA,
  // ETHBTCTrend, cbETH and MATIC were all bought with the owner's own ETH and
  // all five have to survive the predicate.
  test('a token bought with the wallet’s own outflow is a position', () => {
    expect(
      isTradedPosition(
        movements({
          inflowHashes: ['0xswap'],
          signedHashes: new Set(['0xswap']),
          paidHashes: new Set(['0xswap']),
        })
      )
    ).toBe(true);
  });

  test('a token the wallet sold is a position, however it arrived', () => {
    expect(
      isTradedPosition(
        movements({
          inflowHashes: ['0xdrop'],
          outflowHashes: ['0xsell'],
          signedHashes: new Set(['0xsell']),
        })
      )
    ).toBe(true);
  });

  test('an airdrop the wallet claimed for gas is a position', () => {
    // The ENS claim: an ENS airdrop taken for gas in Nov 2021 and sold into
    // ETH. Most of the realized PnL SC-398 recovered is this one token, and the
    // disposal is absent from the ledger on BOTH sides today.
    expect(
      isTradedPosition(movements({ inflowHashes: ['0xclaim'], signedHashes: new Set(['0xclaim']) }))
    ).toBe(true);
  });

  // MUST-BE-ABSENT. These are what find-only exists to keep out, and what a
  // balance-based relaxation would re-admit: the great majority of what was
  // dropped on production.
  test('a token that only ever ARRIVED is not a position', () => {
    expect(isTradedPosition(movements({ inflowHashes: ['0xspam'] }))).toBe(false);
  });

  test('an address-poisoning outflow the wallet never signed is not a position', () => {
    // The attack: a contract named `Tether USD` that is not Tether emits a
    // `Transfer` OUT of the victim's own address for the exact amount of a
    // real transfer minutes earlier. `spam-filter.ts` matches name and symbol
    // and can never see it — the name is genuinely USDT's. The signature can:
    // the attacker signed that transaction, so the hash is not in
    // `signedHashes`, and no naming heuristic is involved at all.
    expect(
      isTradedPosition(
        movements({ outflowHashes: ['0xpoison'], paidHashes: new Set(['0xpoison']) })
      )
    ).toBe(false);
  });

  test('a token with no movements at all is not a position', () => {
    expect(isTradedPosition(movements())).toBe(false);
  });

  // The control that makes the two above mean something: the SAME outflow,
  // with the wallet's signature on it, flips the answer. Without this, a
  // predicate hard-wired to `false` would pass both must-be-ABSENT cases.
  test('the signature is what decides — the same outflow, signed, IS a position', () => {
    const poisoned = movements({ outflowHashes: ['0xh'], paidHashes: new Set(['0xh']) });
    const signed = movements({
      outflowHashes: ['0xh'],
      paidHashes: new Set(['0xh']),
      signedHashes: new Set(['0xh']),
    });
    expect(isTradedPosition(poisoned)).toBe(false);
    expect(isTradedPosition(signed)).toBe(true);
  });

  // SC-764, THE HOLE. One contract emitting BOTH legs in one unsigned
  // transaction: the inflow's only evidence of payment is that same token
  // leaving, because `paidHashes` is fed by `tokentx` rows whose `from` is the
  // wallet — which is exactly the spoofed shape. This read `paid-for` and was
  // admitted.
  test('SC-764: an unsigned in-and-out pair on one contract is not a position', () => {
    const m = movements({
      inflowHashes: ['0xh'],
      outflowHashes: ['0xh'],
      paidHashes: new Set(['0xh']),
    });
    expect(classifyDrop(m)).toBe('unsolicited-arrival');
    expect(isTradedPosition(m)).toBe(false);
  });

  // THE CONTROL THAT PINS THE FIX THAT WAS NOT TAKEN (SC-764). Requiring a
  // signature on the `paid-for` branch closes the case above and returns
  // `unsolicited-arrival` here too — and this is a real purchase. Only an
  // externally-owned account can be a transaction's `from`, so a Safe, an
  // ERC-4337 account and any swap a solver submits reach `paid-for` with
  // `signedHashes` empty by protocol construction. A red here means somebody
  // took the signature route and emptied the answer for every wallet that is
  // not an EOA.
  test('a token bought with ANOTHER asset is a position with no signature anywhere', () => {
    const m = movements({
      inflowHashes: ['0xswap'],
      outflowHashes: [],
      paidHashes: new Set(['0xswap']),
    });
    expect(classifyDrop(m)).toBe('paid-for');
    expect(isTradedPosition(m)).toBe(true);
  });

  // The signed path must not have narrowed with it: the same in-and-out pair,
  // signed, is still a position — by the signature rather than by the payment.
  test('a signed in-and-out pair is still a position', () => {
    const m = movements({
      inflowHashes: ['0xh'],
      outflowHashes: ['0xh'],
      paidHashes: new Set(['0xh']),
      signedHashes: new Set(['0xh']),
    });
    expect(classifyDrop(m)).toBe('claimed-then-sent');
    expect(isTradedPosition(m)).toBe(true);
  });
});

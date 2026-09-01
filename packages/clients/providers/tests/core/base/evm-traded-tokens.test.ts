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

  // SC-764, PINNED AS A KNOWN BEHAVIOUR RATHER THAN AS A WANTED ONE. Read a
  // red here as somebody having narrowed the rule on purpose, not as a
  // regression: `paid-for` is reached with no signature anywhere, because
  // `paidHashes` is fed by `tokentx` rows whose `from` is the wallet — which
  // is exactly the spoofed shape. No poisoning contract measured on production
  // emits an inbound leg as well, so the shape does not occur; the cost if one
  // appeared is one extra unticked row on a review card.
  test('SC-764: an unsigned in-and-out pair is admitted as paid-for', () => {
    const m = movements({
      inflowHashes: ['0xh'],
      outflowHashes: ['0xh'],
      paidHashes: new Set(['0xh']),
    });
    expect(classifyDrop(m)).toBe('paid-for');
    expect(isTradedPosition(m)).toBe(true);
  });
});

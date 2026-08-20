/**
 * WHICH UPSTREAM EVENT a ledger row came from, and what that says about a
 * transfer group whose two legs sit on one holding (SC-347).
 *
 * The question exists because two legs on one holding can be either of two
 * things and they need opposite treatment:
 *
 * - **One event with the wallet or account on both sides.** A Solana
 *   transaction that touches the wallet twice; a Kraken staking reallocation
 *   recorded as two ledger entries. Net zero, position unchanged, and
 *   `walkPool` treats the group as the structural no-op it is (SC-344) — so
 *   the group id is load-bearing and removing it would re-mint the arrival's
 *   lot at that date's market price.
 * - **Two unrelated events the ±1%/±30min matcher paired anyway.** The group
 *   asserts a movement nobody made, and it suppresses the departure from the
 *   review queue so nobody is ever asked about it.
 *
 * **Amount and clock cannot tell those apart, and trying is how the false
 * positives happen.** SC-354 tested a population on quantity and timing and
 * found two rows whose "matching inflow elsewhere" shared a TRANSACTION HASH
 * with a different outflow entirely — the true partner. The upstream event id
 * is the discriminator; quantity and time are what created the question.
 */

import { txHashFromPayload } from '@scani/shared';

/**
 * The id of the upstream event this row belongs to, or null when this source's
 * rows carry no such id.
 *
 * Null means "not readable here", NEVER "no event". A caller deciding whether
 * two legs are one event must treat null as unproven and leave the group alone;
 * unlinking is a positive claim that two events happened.
 *
 * Read per source, because the shape differs and a single rule gets one of them
 * wrong:
 *
 * - **EVM** — the transaction hash, via `txHashFromPayload`, which already
 *   knows the hash lives in `raw_payload.hash` and also leads the
 *   `external_id` for both native and ERC-20 rows.
 * - **Kraken** — `raw_payload.refid`, Kraken's reference for ONE ledger
 *   operation. `external_id` is the per-ENTRY ledger id (`LVMPIT-LXAOV-O5VCSQ`
 *   vs `LJVGEB-2B5KK-O4IF6H` for the same operation), so reading the id is
 *   worse than useless here: it looks like an answer and it is always "two
 *   different events". Every previous measurement of this population did
 *   exactly that and miscounted 22 real single-operation groups as artifacts.
 * - **Solana** — the signature, which is the `external_id` prefix before the
 *   first `-`; the suffix is the balance-change index within the transaction.
 *   Base58 contains no `-`, so the first segment is the whole signature. These
 *   rows carry no `raw_payload` at all in production, which is why it has to
 *   come from the id.
 */
export function upstreamEventKey(
  source: string,
  externalId: string,
  rawPayload: unknown
): string | null {
  const trimmedLower = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() !== '' ? value.trim().toLowerCase() : null;

  switch (source) {
    case 'etherscan':
      return trimmedLower(txHashFromPayload(rawPayload, externalId));
    case 'kraken-api': {
      const payload = typeof rawPayload === 'object' && rawPayload !== null ? rawPayload : null;
      return trimmedLower(payload ? (payload as Record<string, unknown>).refid : null);
    }
    case 'solana': {
      const [signature] = externalId.split('-');
      return trimmedLower(signature);
    }
    default:
      return null;
  }
}

/** One leg of a group, reduced to what the verdict is allowed to depend on. */
export interface GroupLegFacts {
  readonly holdingId: string;
  readonly source: string;
  readonly eventKey: string | null;
}

export interface SameHoldingGroupVerdict {
  /** True only on positive evidence of two distinct upstream events. */
  readonly unlink: boolean;
  readonly reason: string;
}

/**
 * Whether a transfer group is a matcher artifact or one real event.
 *
 * **Every branch that is not "two readable, different event keys" KEEPS the
 * group, and the asymmetry is the design.** Keeping a wrong group costs the
 * semantic error — a movement asserted that nobody made, and a departure
 * hidden from the queue. Unlinking a right one rewrites cost basis at a market
 * price, which is the pop-and-remint SC-344 deleted. The two mistakes are not
 * the same size, so the doubt resolves one way.
 */
export function sameHoldingGroupVerdict(
  legs: ReadonlyArray<GroupLegFacts>
): SameHoldingGroupVerdict {
  if (legs.length < 2) {
    return { unlink: false, reason: `KEEP  ${legs.length} leg(s) — not a pair` };
  }
  if (new Set(legs.map((leg) => leg.holdingId)).size !== 1) {
    return { unlink: false, reason: 'KEEP  spans two holdings — this is a real move' };
  }
  const sources = new Set(legs.map((leg) => leg.source));
  if (sources.size !== 1) {
    return {
      unlink: false,
      reason: `KEEP  two sources (${[...sources].join(', ')}) — no comparable event id`,
    };
  }
  const keys = legs.map((leg) => leg.eventKey);
  if (keys.some((key) => key === null)) {
    return {
      unlink: false,
      reason: `KEEP  source '${legs[0]?.source}' carries no event id — unreadable, not proven`,
    };
  }
  if (new Set(keys).size === 1) {
    return {
      unlink: false,
      reason: `KEEP  one upstream event (${keys[0]?.slice(0, 18)}) — a real no-op`,
    };
  }
  return { unlink: true, reason: 'UNLINK  two different upstream events on one holding' };
}

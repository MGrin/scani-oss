import { Decimal } from '@scani/shared';
import { balanceAt } from './balance-at';
import type { HoldingEvidence } from './types';

/** An outflow answered `internal` to a provider-fed holding (SC-1675). */
export interface Transit {
  /** What the outflow sent, in the destination's token. A fee-reduced arrival still travelled as this. */
  sent: string;
  sentAt: Date;
  /** The transfer group's arrival entry on the destination. */
  arrivalId: string;
  /** The provider's own row is the arrival: taken over, or picked on review. */
  arrived: boolean;
}

/**
 * How much of a transfer is in neither balance at `at`.
 *
 * While the arrival is still the person's leg, it is whatever the
 * destination's balance does not hold of it: a provider reading after the
 * outflow anchors the balance without it. Once the provider's row is the
 * arrival, the money travelled from the outflow to that row's instant. A later
 * reading anchors without the row too, so that case cannot be read off the
 * balance.
 */
export function inTransitAt(destination: HoldingEvidence, transit: Transit, at: Date): Decimal {
  if (at < transit.sentAt) return new Decimal(0);
  const arrival = destination.entries.find((e) => e.id === transit.arrivalId);
  if (arrival === undefined) {
    throw new Error(
      `inTransitAt: holding ${destination.holdingId} has no arrival leg ${transit.arrivalId}`
    );
  }
  const sent = new Decimal(transit.sent);
  if (transit.arrived) return at < arrival.at ? sent : new Decimal(0);
  const without = {
    ...destination,
    entries: destination.entries.filter((e) => e.id !== transit.arrivalId),
  };
  return sent.minus(balanceOrZero(destination, at).minus(balanceOrZero(without, at)));
}

function balanceOrZero(evidence: HoldingEvidence, at: Date): Decimal {
  const answer = balanceAt(evidence, at);
  return answer.status === 'absent' ? new Decimal(0) : answer.balance;
}

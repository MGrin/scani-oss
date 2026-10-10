import type { DatabaseTransaction } from '@scani/db';
import { createComponentLogger } from '@scani/logging';
import { Decimal, TRANSFER_REVIEW_CREATED_SOURCE, transferReviewSplitSchema } from '@scani/shared';
import { Container, Service } from 'typedi';
import { inTransitAt, type Transit } from '../../engine/in-transit';
import type { HoldingEvidence } from '../../engine/types';
import { EngineEvidenceRepository } from '../../repositories/EngineEvidenceRepository';
import { type AnsweredInternalRow, TransitRepository } from '../../repositories/TransitRepository';
import { classifyHoldingEvidence } from '../foundation/legacy-classification';
import { holdingKindOf } from '../holdings/balance-sync-sources';

export interface OpenTransit {
  outflowId: string;
  sourceHoldingId: string;
  destinationHoldingId: string;
  /** The destination's account, which names a part that opened a holding there. */
  destinationAccountId: string;
  /** The destination's token, which is what travels. */
  tokenId: string;
  transit: Transit;
  /** The arrival leg as it stands: the person's at the outflow's instant, or the provider's once it landed. */
  arrival: { quantity: string; at: Date };
  /** When Review asks about it again, after "still waiting" (SC-1675 Q4). */
  askAgainAt: Date | null;
}

export interface TransitAmount {
  outflowId: string;
  sourceHoldingId: string;
  destinationHoldingId: string;
  sentAt: Date;
  tokenId: string;
  at: Date;
  quantity: Decimal;
}

/**
 * Money answered `internal` to a provider-fed holding, while it is in neither
 * balance (SC-1675). A snapshot destination moves its own balance on the
 * answer, so only a feed destination can leave money travelling.
 */
@Service()
export class InTransitService {
  private readonly transits = Container.get(TransitRepository);
  private readonly evidence = Container.get(EngineEvidenceRepository);
  private readonly logger = createComponentLogger('service:InTransitService');

  async openTransits(userId: string, tx?: DatabaseTransaction): Promise<OpenTransit[]> {
    const rows = await this.transits.findAnsweredInternal(userId, tx);
    const open: OpenTransit[] = [];
    for (const row of rows) {
      if (holdingKindOf({ kind: row.kind, source: row.holdingSource }) !== 'feed') continue;
      const sent = sentTo(row);
      if (sent === null) continue;
      open.push({
        outflowId: row.outflowId,
        sourceHoldingId: row.sourceHoldingId,
        destinationHoldingId: row.destinationHoldingId,
        destinationAccountId: row.destinationAccountId,
        tokenId: row.tokenId,
        transit: {
          sent,
          sentAt: row.sentAt,
          arrivalId: row.arrivalId,
          arrived: row.arrivalSource !== TRANSFER_REVIEW_CREATED_SOURCE,
        },
        arrival: { quantity: row.arrivalQuantity, at: row.arrivedAt },
        askAgainAt: row.askAgainAt ? new Date(row.askAgainAt) : null,
      });
    }
    return open;
  }

  /** Every non-zero amount in transit at each instant. */
  async amountsAt(
    userId: string,
    instants: readonly Date[],
    tx?: DatabaseTransaction
  ): Promise<TransitAmount[]> {
    const open = await this.openTransits(userId, tx);
    if (open.length === 0 || instants.length === 0) return [];
    const holdingIds = [...new Set(open.map((o) => o.destinationHoldingId))];
    const evidence = new Map<string, HoldingEvidence>();
    for (const raw of await this.evidence.findHoldingEvidence({ userId, holdingIds }, tx)) {
      evidence.set(raw.holding.id, classifyHoldingEvidence(raw).evidence);
    }
    const amounts: TransitAmount[] = [];
    for (const o of open) {
      const destination = evidence.get(o.destinationHoldingId);
      if (destination?.entries.some((e) => e.id === o.transit.arrivalId) !== true) {
        this.logger.warn(
          { userId, outflowId: o.outflowId, arrivalId: o.transit.arrivalId },
          'a transfer answered internal has no arrival the engine reads; it is not counted in transit'
        );
        continue;
      }
      for (const at of instants) {
        const quantity = inTransitAt(destination, o.transit, at);
        if (quantity.isZero()) continue;
        amounts.push({
          outflowId: o.outflowId,
          sourceHoldingId: o.sourceHoldingId,
          destinationHoldingId: o.destinationHoldingId,
          sentAt: o.transit.sentAt,
          tokenId: o.tokenId,
          at,
          quantity,
        });
      }
    }
    return amounts;
  }
}

/** What the outflow sent to this arrival: the whole of it, or its internal portions to that holding. */
function sentTo(row: AnsweredInternalRow): string | null {
  if (row.review === 'internal') return new Decimal(row.quantity).abs().toFixed();
  const split = transferReviewSplitSchema.safeParse(row.split);
  if (!split.success) return null;
  let sent = new Decimal(0);
  for (const portion of split.data) {
    if (portion.decision !== 'internal' || portion.destination === undefined) continue;
    const { holdingId, accountId } = portion.destination;
    const here =
      holdingId === null
        ? accountId === row.destinationAccountId
        : holdingId === row.destinationHoldingId;
    if (here) sent = sent.plus(portion.quantity);
  }
  return sent.isZero() ? null : sent.toFixed();
}

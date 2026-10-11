import {
  Decimal,
  type TransferDestinationRef,
  type TransferReviewSplit,
  type TransferReviewSplitPortion,
  transferReviewSplitSchema,
} from '@scani/shared';

/** The parts of an answer that carry a reference, so two of them never merge. */
const REFERENCED: ReadonlySet<string> = new Set(['paired', 'internal']);

/**
 * An outflow's answer with the part that travelled replaced (SC-1675).
 *
 * The travelled part is the answer itself when it is `internal`, or the
 * `internal` part of a split aimed at `destination` whose quantity is `sent`.
 * A split may send parts to several holdings (SC-1665), so the size alone can
 * name the wrong one; it never names two, because a split refuses two parts
 * arriving in one holding. `replace` gets that part
 * and returns what it became: the arrived units and a fee, a lost part, or the
 * refund it came back as. A part of zero is left out, and a part whose decision
 * the answer already holds is added to it, so a split never names one decision
 * twice. Null when the answer holds no such part, so the caller refuses rather
 * than writing a split that no longer sums to the outflow.
 */
export function replaceTravelledPart(
  answer: { review: string | null; split: unknown; quantity: string },
  sent: Decimal,
  /** The holding the part arrived in; a whole answer keeps it where `replace` keeps the part. */
  destination: { accountId: string; holdingId: string },
  replace: (travelled: TransferReviewSplitPortion) => readonly TransferReviewSplitPortion[]
): TransferReviewSplit | null {
  let parts: TransferReviewSplitPortion[];
  if (answer.review === 'internal') {
    if (!new Decimal(answer.quantity).abs().eq(sent)) return null;
    parts = [{ decision: 'internal', quantity: sent.toString(), destination }];
  } else if (answer.review === 'split') {
    const parsed = transferReviewSplitSchema.safeParse(answer.split);
    if (!parsed.success) return null;
    parts = [...parsed.data];
  } else {
    return null;
  }
  const at = parts.findIndex(
    (part) =>
      part.decision === 'internal' &&
      aimedAt(part.destination, destination) &&
      new Decimal(part.quantity).eq(sent)
  );
  if (at < 0) return null;
  const [travelled] = parts.splice(at, 1);
  let inserted = false;
  for (const part of replace(travelled!)) {
    if (!new Decimal(part.quantity).gt(0)) continue;
    const same = REFERENCED.has(part.decision)
      ? -1
      : parts.findIndex((other) => other.decision === part.decision);
    if (same >= 0) {
      const other = parts[same]!;
      parts[same] = {
        ...other,
        quantity: new Decimal(other.quantity).plus(part.quantity).toString(),
      };
    } else if (!inserted) {
      parts.splice(at, 0, part);
      inserted = true;
    } else {
      parts.push(part);
    }
  }
  return parts;
}

/** Whether a part names this holding, or the account it opened a holding in. */
function aimedAt(
  to: TransferDestinationRef | undefined,
  destination: { accountId: string; holdingId: string }
): boolean {
  if (to === undefined) return false;
  return to.holdingId === null
    ? to.accountId === destination.accountId
    : to.holdingId === destination.holdingId;
}

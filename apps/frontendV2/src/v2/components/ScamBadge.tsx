import { ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

/** Kept aligned with packages/core/src/config/tokens.ts. */
export const SCAM_PROBABILITY_THRESHOLD = 0.35;

/** Does this `isScamProbability` value count as scam in the UI? */
export function isScamToken(probability: number | null | undefined): boolean {
  return typeof probability === 'number' && probability >= SCAM_PROBABILITY_THRESHOLD;
}

interface ScamBadgeProps {
  probability: number | null | undefined;
  className?: string;
}

/**
 * Red pill rendered next to any holding whose token is flagged as scam.
 * Renders nothing when the probability is below threshold — callers can
 * always pass `token.isScamProbability` without guarding first.
 */
export function ScamBadge({ probability, className }: ScamBadgeProps) {
  if (!isScamToken(probability)) return null;
  return (
    <Badge
      variant="destructive"
      className={`gap-1 h-5 px-1.5 text-[10px] ${className ?? ''}`}
      title="Marked as scam — still shown here so you can review; hidden from token search."
    >
      <ShieldAlert className="h-3 w-3" />
      Scam
    </Badge>
  );
}

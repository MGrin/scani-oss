/**
 * What one write did, returned by both A2 writers. A4 turns it into the outbox
 * row in the same transaction; until then the caller reads it, for instance to
 * widen a history rebuild back to `earliestChangedAt` (D-9).
 */
export interface IngestOutcome {
  userId: string;
  touchedHoldingIds: string[];
  createdHoldingIds: string[];
  earliestChangedAt: Date | null;
  notices: string[];
}

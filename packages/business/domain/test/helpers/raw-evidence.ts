import type {
  EvidenceObservation,
  EvidenceTransaction,
  LegacyHoldingEvidence,
} from '../../src/services/foundation/legacy-classification';

/**
 * A holding's evidence as `EngineEvidenceRepository` loads it, for a stub of
 * that repository: a feed holding whose readings are provider checkpoints, the
 * rows the engine anchors on (SC-1637).
 */
export function rawEvidence(
  holdingId: string,
  readings: ReadonlyArray<{ observedAt: Date; balance: string; gapReview?: string | null }>,
  transactions: ReadonlyArray<
    Pick<EvidenceTransaction, 'id' | 'kind' | 'quantity' | 'occurredAt'> &
      Partial<EvidenceTransaction>
  > = []
): LegacyHoldingEvidence {
  const createdAt = readings[0]?.observedAt ?? new Date('2026-01-01T00:00:00Z');
  const holding: LegacyHoldingEvidence['holding'] = {
    id: holdingId,
    accountId: 'account-1',
    tokenId: 'token-1',
    source: 'import_kraken',
    externalId: null,
    kind: 'feed',
    startsAt: null,
    balance: '0',
    lastUpdated: createdAt,
    createdAt,
  };
  const observations: EvidenceObservation[] = readings.map((r, i) => ({
    id: `${holdingId}-o${i}`,
    holdingId,
    balance: r.balance,
    observedAt: r.observedAt,
    source: 'sync-capture',
    gapReview: r.gapReview ?? null,
    role: 'checkpoint',
    authority: 'provider',
    inputId: null,
    cause: null,
    supersededAt: null,
    createdAt: r.observedAt,
    metadataOrigin: null,
    metadataSource: null,
    metadataLegacyAnchor: null,
  }));
  // A test's ledger rows name only what the walk reads; the rest is a
  // person's plain entry, which the classifier keeps.
  const entries: EvidenceTransaction[] = transactions.map((t) => ({
    id: t.id,
    holdingId: t.holdingId ?? holdingId,
    kind: t.kind,
    quantity: t.quantity,
    occurredAt: t.occurredAt,
    source: t.source ?? 'manual',
    externalId: t.externalId ?? `ext-${t.id}`,
    transferGroupId: t.transferGroupId ?? null,
    swapGroupId: t.swapGroupId ?? null,
    settlesTransactionId: t.settlesTransactionId ?? null,
    priceNative: t.priceNative ?? null,
    priceNativeTokenId: t.priceNativeTokenId ?? null,
    ledgerKind: t.ledgerKind ?? null,
    kindSubtype: t.kindSubtype ?? null,
    groupId: t.groupId ?? null,
    feeOf: t.feeOf ?? null,
    inputId: t.inputId ?? null,
    executionPrice: t.executionPrice ?? null,
    executionPriceTokenId: t.executionPriceTokenId ?? null,
    kindOrigin: t.kindOrigin ?? null,
    decisionId: t.decisionId ?? null,
    createdAt: t.createdAt ?? t.occurredAt,
    metadataIncome: t.metadataIncome ?? null,
    metadataFeeOf: t.metadataFeeOf ?? null,
  }));
  return { holding, observations, transactions: entries, inputs: [], windows: [] };
}

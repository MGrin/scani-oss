/**
 * What `BalanceGapService.answer` leaves on the closing observation's
 * `source_metadata.gapAnswer`: the request it answered, the rows it wrote, and
 * when. `keptAfterSettlementsAt` is the owner choosing Keep in the settlement
 * review (SC-1453), which takes the answer out of that review for good.
 */
export interface GapAnswerReceipt {
  request?: string;
  transactionId?: string | null;
  feeTransactionId?: string | null;
  answeredAt?: string;
  keptAfterSettlementsAt?: string;
}

/** The sources an answer writes its own rows under. */
export const GAP_ANSWER_ROW_SOURCES = ['user-balance-edit', 'user-balance-correction'] as const;

export function readGapAnswerReceipt(metadata: unknown): GapAnswerReceipt | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const receipt = (metadata as Record<string, unknown>).gapAnswer;
  return receipt && typeof receipt === 'object' ? (receipt as GapAnswerReceipt) : undefined;
}

export function gapAnswerRowIds(receipt: GapAnswerReceipt | undefined): string[] {
  return [receipt?.transactionId, receipt?.feeTransactionId].filter((id): id is string => !!id);
}

/**
 * The destination decision the answer gave, read from its own request. Only a
 * `flow` answer for money that left carries one.
 */
export function gapAnswerOutflowDecision(receipt: GapAnswerReceipt | undefined): string | null {
  if (!receipt?.request) return null;
  try {
    const request = JSON.parse(receipt.request) as { editOutflow?: { decision?: unknown } | null };
    const decision = request.editOutflow?.decision;
    return typeof decision === 'string' ? decision : null;
  } catch {
    return null;
  }
}

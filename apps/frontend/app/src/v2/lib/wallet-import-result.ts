/**
 * Reading a `wallet-import` job result truthfully.
 *
 * Pure, and separate from the renderer, because the thing that went wrong
 * twice in this job kind was not layout — it was the interpretation. A
 * failed chain fetch was reported as "0 tokens across 0 chains" (SC-139)
 * and a payload we never received was reported as a provider rejection
 * that never happened (SC-145). Both are single-line decisions about what
 * the result means, and they are worth testing without a DOM.
 *
 * The invariant these functions exist to hold: **"we could not read this"
 * and "this is empty" are different answers and must never collapse into
 * one.** Everything below keeps them apart.
 */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** A number field, tolerating the array form older results used. */
export function asCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return Array.isArray(value) ? value.length : 0;
}

/**
 * Per-chain failures, flattened to one line each.
 *
 * The producer pushes `{chainId, chainName, error}`
 * (`ImportWalletAddressUseCase.fetchChainData`), but older rows carry bare
 * strings and nothing stops a future shape, so anything unrecognised is
 * stringified rather than dropped. A failure the user never sees is the
 * whole defect (SC-139).
 */
export function readChainErrors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === 'string') return entry;
    const record = asRecord(entry);
    const message = typeof record.error === 'string' ? record.error : JSON.stringify(entry);
    const chain = typeof record.chainName === 'string' ? record.chainName : null;
    return chain && chain !== 'Unknown' ? `${chain}: ${message}` : message;
  });
}

/**
 * What the balance fetch actually established.
 *
 * `empty` and `unreadable` are the two outcomes the review card used to
 * collapse into a single "0 tokens" line — a wallet we could not read was
 * reported to the user as a wallet with nothing in it. They are opposite
 * facts about someone's money: one is an answer, the other is the absence
 * of one.
 */
export type FetchOutcome = 'found' | 'partial' | 'empty' | 'unreadable';

export function classifyFetch(candidateCount: number, failedChains: number): FetchOutcome {
  if (candidateCount > 0) return failedChains > 0 ? 'partial' : 'found';
  return failedChains > 0 ? 'unreadable' : 'empty';
}

/** True when the outcome is a reading of the wallet rather than a failure. */
export function statesWalletContents(outcome: FetchOutcome): boolean {
  return outcome !== 'unreadable';
}

import { Container, Token } from 'typedi';
import { userFacingMessage } from '../core/user-facing';

/**
 * A sentence for the owner about a failure nobody marked `userFacing`
 * (SC-1711).
 *
 * The marked path covers what a processor anticipated. A provider's 429
 * thrown from three layers down was not, so the owner got a failed job and
 * no reason. The app knows its error classes and this package does not, so
 * the app binds one; it must return its OWN sentence, never the error's
 * words, for the reason `userFacing` is opt-in (SC-551).
 */
export abstract class FailureExplainer {
  abstract explain(error: unknown): string | null;
}

export const FAILURE_EXPLAINER = new Token<FailureExplainer>('queue.failure-explainer');

/** What the owner is told: the marked message, else the app's explanation, else nothing. */
export function ownerReason(error: unknown): string | null {
  const marked = userFacingMessage(error);
  if (marked) return marked;
  let explainer: FailureExplainer;
  try {
    explainer = Container.get(FAILURE_EXPLAINER);
  } catch {
    return null;
  }
  return explainer.explain(error);
}

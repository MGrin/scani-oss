import { ReturnsLastCompleteRepository } from '@scani/domain/repositories';
import type { BenchmarkReturnService } from '@scani/domain/services';
import { createComponentLogger } from '@scani/logging';
import { Container } from 'typedi';
import type { ReturnsResponse } from './returns-response';

const logger = createComponentLogger('returns-last-complete');
const DAY_MS = 86_400_000;

export interface ReturnsAnswer {
  returns: ReturnsResponse;
  benchmarks: Awaited<ReturnType<BenchmarkReturnService['over']>>;
}

/** SC-1694: the last eligible answer, shown "as of" `computedAt` while history rebuilds. */
export type LastComplete = ReturnsAnswer & { computedAt: string };

interface AnswerKey {
  userId: string;
  scope: unknown;
  window: { kind: 'ytd' | '1y' | 'all' } | { kind: 'custom'; from: Date; to: Date };
}

// A custom window is kept by its length: Home's periods end today, so the same
// period asked a day later is a different window of the same length.
function windowKey(window: AnswerKey['window']): string {
  if (window.kind !== 'custom') return window.kind;
  return `custom:${Math.round((window.to.getTime() - window.from.getTime()) / DAY_MS)}d`;
}

/** Not awaited: a failed write costs only the next rebuild's card, never this answer. */
export function keepLastComplete(key: AnswerKey, answer: ReturnsAnswer): void {
  Container.get(ReturnsLastCompleteRepository)
    .save({
      userId: key.userId,
      scopeKey: JSON.stringify(key.scope),
      windowKey: windowKey(key.window),
      baseCurrencyId: answer.returns.baseCurrencyId,
      answer,
      computedAt: new Date(),
    })
    .catch((err: unknown) =>
      logger.warn({ err, userId: key.userId }, 'Could not keep the last complete returns answer')
    );
}

/** `null` when nothing was kept, it was kept in another base currency, or the read failed. */
export async function findLastComplete(
  key: AnswerKey,
  baseCurrencyId: string
): Promise<LastComplete | null> {
  try {
    const row = await Container.get(ReturnsLastCompleteRepository).find(
      key.userId,
      JSON.stringify(key.scope),
      windowKey(key.window)
    );
    if (!row || row.baseCurrencyId !== baseCurrencyId) return null;
    return { ...(row.answer as ReturnsAnswer), computedAt: row.computedAt.toISOString() };
  } catch (err) {
    logger.warn({ err, userId: key.userId }, 'Could not read the last complete returns answer');
    return null;
  }
}

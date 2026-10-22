import {
  type LastComplete,
  type ReturnsAnswer,
  ReturnsLastCompleteService,
} from '@scani/domain/services';
import { createComponentLogger } from '@scani/logging';
import { Container } from 'typedi';

const logger = createComponentLogger('returns-last-complete');

export type { LastComplete };

interface AnswerKey {
  userId: string;
  scope: { kind: 'user' } | { kind: 'account' | 'institution'; id: string };
  window: { kind: 'ytd' | '1y' | 'all' } | { kind: 'custom'; from: Date; to: Date };
}

/** Not awaited: a failed write costs only the next rebuild's card, never this answer. */
export function keepLastComplete(key: AnswerKey, answer: ReturnsAnswer): void {
  Container.get(ReturnsLastCompleteService)
    .keep(key.userId, key.scope, key.window, answer)
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
    return await Container.get(ReturnsLastCompleteService).find(
      key.userId,
      key.scope,
      key.window,
      baseCurrencyId
    );
  } catch (err) {
    logger.warn({ err, userId: key.userId }, 'Could not read the last complete returns answer');
    return null;
  }
}

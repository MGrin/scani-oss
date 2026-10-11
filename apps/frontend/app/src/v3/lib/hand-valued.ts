import type {
  HandValuedDirection,
  MoveHandValuedMoneyInput,
  UpdateHandValueInput,
} from '@scani/shared';
import { httpStatus } from '@scani/ui/lib/user-facing-error';
import { describeQueryError } from '@scani/ui/v3/lib/errors';
import { dateFieldInstant } from '../components/form/DateField';
import { parsePositivePrice } from './custom-tokens';

export interface ValueDraft {
  value: string;
  date: string;
}

export interface MoneyDraft {
  direction: HandValuedDirection;
  amount: string;
  date: string;
}

export function buildValueUpdate(
  holdingId: string,
  currencyCode: string,
  draft: ValueDraft
): UpdateHandValueInput | null {
  if (parsePositivePrice(draft.value) === null || draft.date === '') return null;
  return { holdingId, currencyCode, value: draft.value, occurredAt: dateFieldInstant(draft.date) };
}

export function buildMoneyMove(
  holdingId: string,
  currencyCode: string,
  draft: MoneyDraft
): MoveHandValuedMoneyInput | null {
  if (parsePositivePrice(draft.amount) === null || draft.date === '') return null;
  return {
    holdingId,
    currencyCode,
    direction: draft.direction,
    amount: draft.amount,
    occurredAt: dateFieldInstant(draft.date),
  };
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Each refusal the server can give, said in the reader's language. */
export function describeHandValuedFailure(t: Translate, error: unknown): string {
  switch (httpStatus(error)) {
    case 400:
      return t('v3.holdings.handValued.error.nothingHeld');
    case 409:
      return t('v3.holdings.handValued.error.tooMuch');
    case 412:
      return t('v3.holdings.handValued.error.noPriceYet');
    default: {
      const copy = describeQueryError(error, t('v3.holdings.handValued.subject'), 'save');
      return `${copy.title}. ${copy.detail}`;
    }
  }
}

/** Money is typed to the cent's hundredth, not to a unit's 18 places. */
export const HAND_VALUED_MONEY_SCALE = 4;

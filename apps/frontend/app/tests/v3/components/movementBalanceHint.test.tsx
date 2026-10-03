import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MovementWhatFields } from '../../../src/v3/components/holdings/MovementFields';
import type { MovementForm } from '../../../src/v3/hooks/useMovementForm';
import type { MovementHolding } from '../../../src/v3/lib/movement-form';

/** SC-1253: the balance under the amount reads as the holdings table does. */
function markupFor(amount: string, date = '2026-09-19'): string {
  const selected = { id: 'h1', amount, token: { symbol: 'EUR' } } as unknown as MovementHolding;
  const form = {
    holdingId: 'h1',
    selected,
    direction: 'out',
    amount: '',
    fee: '',
    feeArrives: false,
    feeBlocked: false,
    date,
    note: '',
    selectHolding() {},
    chooseDirection() {},
    setAmount() {},
    setFee() {},
    setDate() {},
    setNote() {},
  } as unknown as MovementForm;
  return renderToStaticMarkup(
    <MovementWhatFields form={form} holding={selected} holdings={[selected]} disabled={false} />
  );
}

function hintFor(amount: string): string {
  return /Currently [^<]*/.exec(markupFor(amount))?.[0] ?? '';
}

describe('the current-balance hint', () => {
  test('groups thousands', () => {
    expect(hintFor('27550')).toBe('Currently 27,550 EUR');
  });

  test('keeps the decimals a small balance needs', () => {
    expect(hintFor('0.01234567')).toBe('Currently 0.01234567 EUR');
  });
});

describe('the date hint (SC-1518)', () => {
  const future = 'That date is in the future';

  test('warns when the movement is dated after today', () => {
    expect(markupFor('100', '2099-01-01')).toContain(future);
  });

  test('says nothing for a past date', () => {
    expect(markupFor('100', '2026-09-19')).not.toContain(future);
  });
});

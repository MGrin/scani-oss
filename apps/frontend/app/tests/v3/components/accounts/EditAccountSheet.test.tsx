import '../../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  accountUpdatePayload,
  EditAccountFields,
  typesOfClass,
} from '@/v3/components/accounts/EditAccountSheet';

// SC-1645. The sheet is a Radix dialog and renders nothing statically, so its
// body and its two decisions are asserted here; the refusal copy is the
// server's sentence, shown by FormActions like every other sheet.

const types = [
  { id: 't-inv', code: 'investment', name: 'Investment', class: 'asset' },
  { id: 't-sav', code: 'savings', name: 'Savings', class: 'asset' },
  { id: 't-mort', code: 'mortgage', name: 'Mortgage', class: 'liability' },
];
const wrappers = [
  { code: 'isa', region: 'uk', treatment: 'exempt', displayOrder: 16 },
  { code: 'pension', region: null, treatment: 'deferred', displayOrder: 40 },
] as const;

describe('typesOfClass', () => {
  test('offers only the types on the account’s own side', () => {
    expect(typesOfClass(types, 't-inv').map((t) => t.id)).toEqual(['t-inv', 't-sav']);
    expect(typesOfClass(types, 't-mort').map((t) => t.id)).toEqual(['t-mort']);
  });
});

describe('accountUpdatePayload', () => {
  const original = { name: 'ISA', typeId: 't-inv', wrapper: null };
  test('sends only what changed', () => {
    expect(
      accountUpdatePayload(original, { name: 'ISA', typeId: 't-inv', wrapper: 'isa' })
    ).toEqual({
      wrapper: 'isa',
    });
    expect(
      accountUpdatePayload(original, { name: ' My ISA ', typeId: 't-sav', wrapper: null })
    ).toEqual({
      name: 'My ISA',
      typeId: 't-sav',
    });
  });
  test('nothing changed is null', () => {
    expect(accountUpdatePayload(original, { ...original })).toBeNull();
  });
});

describe('EditAccountFields', () => {
  const render = (typeId: string) =>
    renderToStaticMarkup(
      <EditAccountFields
        draft={{ name: 'Main', typeId, wrapper: null }}
        onChange={() => {}}
        types={types}
        wrappers={wrappers}
        region="uk"
      />
    );

  test('an asset account shows name, type and wrapper', () => {
    const html = render('t-inv');
    expect(html).toInclude('value="Main"');
    expect(html).toInclude('Account wrapper');
  });

  test('a liability account has no wrapper field', () => {
    expect(render('t-mort')).not.toInclude('Account wrapper');
  });
});

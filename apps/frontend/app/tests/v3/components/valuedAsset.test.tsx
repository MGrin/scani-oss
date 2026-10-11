import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ValuedAssetDetailsView } from '../../../src/v3/components/assets/ValuedAssetDetails';

const history = {
  name: 'Lisbon flat',
  details: { kind: 'property' as const, address: 'Rua X 1', areaSqm: 72 },
  purchase: { on: '2021-04-12', price: '310000' },
  valuations: [
    { on: '2021-04-12', value: '310000', recordedAt: '2021-04-12T00:00:00.000Z', replaced: false },
    { on: '2023-06-01', value: '330000', recordedAt: '2023-06-01T00:00:00.000Z', replaced: true },
    { on: '2023-06-01', value: '333000', recordedAt: '2023-06-01T00:00:00.001Z', replaced: false },
  ],
  current: '355000',
  gain: '45000',
  currencyCode: 'EUR',
};

describe('ValuedAssetDetailsView (SC-1643)', () => {
  const html = renderToStaticMarkup(
    createElement(ValuedAssetDetailsView, { history, locale: 'en-US' })
  );

  test('lists valuations newest first', () => {
    const newest = html.indexOf('333,000');
    const corrected = html.indexOf('330,000');
    expect(newest).toBeGreaterThan(-1);
    expect(corrected).toBeGreaterThan(newest);
  });

  test('labels the corrected row', () => {
    expect(html).toContain('Corrected');
  });

  test('shows the gain since purchase and the address', () => {
    expect(html).toContain('45,000');
    expect(html).toContain('Rua X 1');
    expect(html).toContain('775 ft²');
  });
});

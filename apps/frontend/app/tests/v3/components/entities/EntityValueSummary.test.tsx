import '../../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { EntityValueSummary } from '../../../../src/v3/components/entities/EntityValueSummary';

const PARTS = [
  { key: 'margin', label: 'Margin', value: 10_000 },
  { key: 'spot', label: 'Spot', value: 5_000 },
];

function render(totalDebt: number, allocation = PARTS): string {
  return renderToStaticMarkup(
    <EntityValueSummary
      value={15_000 + totalDebt}
      totalDebt={totalDebt}
      currency="USD"
      allocation={allocation}
      allocationLabel="Value by account"
    />
  );
}

describe('EntityValueSummary margin debt (SC-1463)', () => {
  test('the hero is net, and the debt is its own line under a bar of assets', () => {
    const html = render(-2_500);
    expect(html).toInclude('12,500.00');
    expect(html).toInclude('data-ui="debt"');
    expect(html).toInclude('−$2,500.00');
    expect(html).toInclude('Share of assets');
  });

  test('no debt: no line, no caption', () => {
    const html = render(0);
    expect(html).not.toInclude('data-ui="debt"');
    expect(html).not.toInclude('Share of assets');
  });

  test('with no bar to draw, the debt line still shows', () => {
    const html = render(-2_500, [{ key: 'margin', label: 'Margin', value: 10_000 }]);
    expect(html).not.toInclude('allocation-bar');
    expect(html).toInclude('data-ui="debt"');
  });
});

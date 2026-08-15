import { describe, expect, test } from 'bun:test';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { renderToStaticMarkup } from 'react-dom/server';

// Static markup rather than a DOM: the repo has no DOM test environment, and
// what these tests are protecting is the rendered output — the classes that
// carry the token, and the characters that carry the direction without it.

describe('Numeric — the numeric type role', () => {
  test('every figure is monospaced, tabular and tracked, without the call site asking', () => {
    const html = renderToStaticMarkup(<Numeric value={1234.5} currency="USD" />);
    expect(html).toInclude('font-mono');
    expect(html).toInclude('tabular-nums');
    expect(html).toInclude('tracking-numeric');
    expect(html).toInclude('$1,234.50');
  });

  test('sets no font size — the role is a treatment and the caller owns the scale', () => {
    const html = renderToStaticMarkup(
      <Numeric value={1} currency="USD" className="text-display" />
    );
    expect(html).toInclude('text-display');
    expect(html).not.toMatch(/text-(label|caption|body|title)\b/);
  });

  test('passes span attributes through', () => {
    const html = renderToStaticMarkup(<Numeric value={1} currency="USD" data-testid="total" />);
    expect(html).toInclude('data-testid="total"');
  });
});

describe('Numeric — gain and loss are never colour alone', () => {
  test('a gain carries the token, a sign and an arrow', () => {
    const html = renderToStaticMarkup(<Numeric value={1234.5} currency="USD" delta />);
    expect(html).toInclude('text-gain');
    expect(html).toInclude('+$1,234.50');
    expect(html).toInclude('↑');
  });

  test('a loss carries the token, a sign and an arrow', () => {
    const html = renderToStaticMarkup(<Numeric value={-1234.5} currency="USD" delta />);
    expect(html).toInclude('text-loss');
    expect(html).toInclude('−$1,234.50');
    expect(html).toInclude('↓');
  });

  test('zero takes the neutral token, not the gain one', () => {
    const html = renderToStaticMarkup(<Numeric value={0} currency="USD" delta />);
    expect(html).toInclude('text-neutral');
    expect(html).not.toInclude('text-gain');
    expect(html).not.toInclude('↑');
  });

  // The whole point of the component: v2 encoded direction as
  // `text-green-600` / `text-red-600` with no second channel, in 47 places.
  test.each([
    1234.5, -1234.5,
  ])('the direction of %p survives with every colour stripped', (value) => {
    const html = renderToStaticMarkup(<Numeric value={value} currency="USD" delta />);
    const withoutColour = html.replace(/class="[^"]*"/g, '');
    expect(withoutColour).toMatch(value > 0 ? /[+↑]/ : /[−↓]/);
  });

  test('indicator="sign" drops the arrow and keeps the sign', () => {
    const html = renderToStaticMarkup(
      <Numeric value={-1234.5} currency="USD" delta indicator="sign" />
    );
    expect(html).not.toInclude('↓');
    expect(html).toInclude('−$1,234.50');
  });

  test('the arrow is hidden from assistive tech, which reads the sign instead', () => {
    const html = renderToStaticMarkup(<Numeric value={5} currency="USD" delta />);
    expect(html).toInclude('<span aria-hidden="true">↑');
  });

  test('a magnitude takes no gain/loss token even when negative', () => {
    const html = renderToStaticMarkup(<Numeric value={-1234.5} currency="USD" />);
    expect(html).not.toInclude('text-loss');
    expect(html).not.toInclude('↓');
    expect(html).toInclude('−$1,234.50');
  });
});

describe('Numeric — the placeholder', () => {
  test('an absent value says so in words as well as a dash', () => {
    const html = renderToStaticMarkup(<Numeric value={null} currency="USD" />);
    expect(html).toInclude('<span aria-hidden="true">—</span>');
    expect(html).toInclude('No value');
    expect(html).toInclude('sr-only');
  });

  test('the placeholder is muted, not toned', () => {
    const html = renderToStaticMarkup(<Numeric value={null} currency="USD" delta />);
    expect(html).toInclude('text-muted-foreground');
    expect(html).not.toInclude('text-neutral');
  });
});

describe('Numeric — formats', () => {
  test('percent', () => {
    expect(renderToStaticMarkup(<Numeric value={4.213} format="percent" delta />)).toInclude(
      '+4.21%'
    );
  });

  test('percent at one decimal', () => {
    expect(renderToStaticMarkup(<Numeric value={4.213} format="percent" decimals={1} />)).toInclude(
      '4.2%'
    );
  });

  test('plain, for a unit count where the currency lives elsewhere on the row', () => {
    expect(renderToStaticMarkup(<Numeric value={1500.5} format="plain" />)).toInclude('1,500.5');
  });

  test('compact, for a chart axis or a summary tile', () => {
    expect(renderToStaticMarkup(<Numeric value={12_800} currency="USD" compact />)).toInclude(
      '$12.8K'
    );
  });
});

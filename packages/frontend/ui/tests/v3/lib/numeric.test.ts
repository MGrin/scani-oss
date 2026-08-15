import { describe, expect, test } from 'bun:test';
import { resolveNumeric } from '@scani/ui/v3/lib/numeric';

const USD = { currency: 'USD' } as const;

describe('resolveNumeric — magnitudes', () => {
  test('formats currency at two decimals by default', () => {
    expect(resolveNumeric(1234.5, USD).magnitude).toBe('$1,234.50');
  });

  test('a negative magnitude keeps its sign but takes no tone', () => {
    const parts = resolveNumeric(-500, USD);
    // An account can hold a negative balance without that being a loss, so a
    // magnitude is never coloured.
    expect(parts.tone).toBeNull();
    expect(parts.text).toBe('−$500.00');
  });

  test('accepts the Decimal-as-string shape the API returns', () => {
    expect(resolveNumeric('1234.5', USD).magnitude).toBe('$1,234.50');
  });

  test('honours an explicit decimals override', () => {
    expect(resolveNumeric(1234.5, { ...USD, decimals: 0 }).magnitude).toBe('$1,235');
  });

  test('compact notation for large figures', () => {
    expect(resolveNumeric(12_800, { ...USD, compact: true }).magnitude).toBe('$12.8K');
  });

  test('percent and plain formats need no currency', () => {
    expect(resolveNumeric(4.2, { format: 'percent' }).magnitude).toBe('4.20%');
    expect(resolveNumeric(1500, { format: 'plain' }).magnitude).toBe('1,500');
  });

  // Intl rejects anything that is not a well-formed three-letter code, and
  // `tokens.symbol` holds arbitrary tickers.
  test('a currency code Intl rejects falls back rather than throwing', () => {
    expect(resolveNumeric(10, { currency: 'BITCOIN' }).magnitude).toBe('BITCOIN 10.00');
  });
});

/**
 * SC-179. A price is a figure the reader multiplies by the balance beside it,
 * and `4,200,000 × $0.00` contradicts the `$324.03` on the same row.
 */
describe('resolveNumeric — money below a cent', () => {
  test('a sub-cent price is shown rather than rounded away', () => {
    expect(resolveNumeric(0.00007714915547392611, USD).magnitude).toBe('$0.00007715');
  });

  test('anything a cent can express is still two decimals', () => {
    expect(resolveNumeric(0.01, USD).magnitude).toBe('$0.01');
    expect(resolveNumeric(0.009, USD).magnitude).toBe('$0.01');
    expect(resolveNumeric(62000, USD).magnitude).toBe('$62,000.00');
  });

  test('an explicit precision still wins', () => {
    expect(resolveNumeric(0.00007714, { ...USD, decimals: 2 }).magnitude).toBe('$0.00');
  });

  test('a delta keeps its two, so a change that reads as zero is not toned', () => {
    // The rule `displayedDecimals` documents: extending here would report
    // −$0.004 as a loss, complete with a red arrow, on a screen showing $0.00.
    const parts = resolveNumeric(-0.004, { ...USD, delta: true });
    expect(parts.magnitude).toBe('$0.00');
    expect(parts.tone).toBe('neutral');
  });
});

describe('resolveNumeric — the minus glyph', () => {
  // One column must not mix U+002D and U+2212: the hyphen is narrower than a
  // digit cell even in a monospaced face.
  test('every minus is U+2212, never a hyphen-minus', () => {
    for (const parts of [
      resolveNumeric(-500, USD),
      resolveNumeric(-4.2, { format: 'percent' }),
      resolveNumeric(-1500, { format: 'plain' }),
      resolveNumeric(-12_800, { ...USD, compact: true }),
      resolveNumeric(-500, { ...USD, delta: true }),
    ]) {
      expect(parts.text).not.toInclude('-');
      expect(parts.text).toInclude('−');
    }
  });
});

describe('resolveNumeric — deltas', () => {
  test('a gain is signed, arrowed and toned', () => {
    expect(resolveNumeric(1234.5, { ...USD, delta: true })).toEqual({
      tone: 'gain',
      sign: '+',
      arrow: '↑',
      magnitude: '$1,234.50',
      text: '+$1,234.50',
      isPlaceholder: false,
    });
  });

  test('a loss carries the sign once, not twice', () => {
    const parts = resolveNumeric(-1234.5, { ...USD, delta: true });
    expect(parts).toEqual({
      tone: 'loss',
      sign: '−',
      arrow: '↓',
      magnitude: '$1,234.50',
      text: '−$1,234.50',
      isPlaceholder: false,
    });
  });

  test('zero is neutral with no sign and no arrow', () => {
    expect(resolveNumeric(0, { ...USD, delta: true })).toMatchObject({
      tone: 'neutral',
      sign: '',
      arrow: '',
      text: '$0.00',
    });
  });

  // The sign comes from the figure the user sees, not the input: reporting a
  // loss on something that renders as $0.00 describes a change that isn't
  // visible anywhere on the screen.
  test('a value that rounds away to zero is neutral', () => {
    expect(resolveNumeric(-0.004, { ...USD, delta: true })).toMatchObject({
      tone: 'neutral',
      sign: '',
      arrow: '',
      text: '$0.00',
    });
    expect(resolveNumeric(0.004, { format: 'percent', delta: true })).toMatchObject({
      tone: 'neutral',
      text: '0.00%',
    });
  });

  test('a value that survives rounding keeps its direction', () => {
    expect(resolveNumeric(-0.006, { ...USD, delta: true })).toMatchObject({
      tone: 'loss',
      text: '−$0.01',
    });
  });

  test('rounding is judged at the precision compact notation will use', () => {
    // `formatCompact` falls back to 0 decimals below 1,000, so 0.4 disappears
    // there and survives as $1.2K above it.
    expect(resolveNumeric(0.4, { ...USD, compact: true, delta: true })).toMatchObject({
      tone: 'neutral',
      text: '$0',
    });
    expect(resolveNumeric(1234, { ...USD, compact: true, delta: true })).toMatchObject({
      tone: 'gain',
      text: '+$1.2K',
    });
  });

  test('a plain delta with no decimals set is not rounded at all', () => {
    expect(resolveNumeric(0.004, { format: 'plain', delta: true })).toMatchObject({
      tone: 'gain',
      text: '+0.004',
    });
  });
});

describe('resolveNumeric — the placeholder', () => {
  test.each([
    null,
    undefined,
    '',
    '   ',
    'not a number',
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('renders %p as the unpriceable placeholder rather than zero', (value) => {
    const parts = resolveNumeric(value, USD);
    expect(parts.isPlaceholder).toBe(true);
    expect(parts.text).toBe('—');
    expect(parts.tone).toBeNull();
  });

  // `@scani/shared`'s formatCurrency renders NaN as $0.00 on purpose so v2
  // callers never had to sanitize; v3 refuses to state a figure it does not
  // have.
  test('a placeholder never renders as a money value', () => {
    expect(resolveNumeric(Number.NaN, USD).text).not.toInclude('0');
  });
});

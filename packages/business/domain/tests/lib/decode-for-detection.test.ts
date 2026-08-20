import { describe, expect, test } from 'bun:test';
import { decodeForDetection } from '../../src/lib/decode-for-detection';
import { decodeProviderText } from '../../src/lib/decode-provider-text';

/**
 * SC-281. Two decoders exist on purpose and this file is where the difference
 * is asserted rather than described.
 *
 * `decodeProviderText` writes its answer into a display column, so its table is
 * six entries and stays that way. `decodeForDetection` produces a throwaway
 * string for a regex, so it can enumerate the whole ASCII channel.
 */
describe('the two decoders answer different questions', () => {
  test('storage leaves `&period;` alone and detection resolves it', () => {
    expect(decodeProviderText('#HEXPool&period;net')).toBe('#HEXPool&period;net');
    expect(decodeForDetection('#HEXPool&period;net')).toBe('#HEXPool.net');
  });

  /**
   * The storage decoder's minimality is not a bug to be fixed later — it is
   * the reason a legitimate `&sect;` in an instrument name survives. If this
   * ever fails because someone grew the six-entry table to close an evasion,
   * the evasion was already closed here and the display column just became
   * lossy for nothing.
   */
  test('closing the evasion did not grow the storage table', () => {
    for (const raw of ['FOO&bar;BAZ', 'S&sect;P', 'A&period;B', 'X&sol;Y']) {
      expect(decodeProviderText(raw), raw).toBe(raw);
    }
  });
});

describe('decodeForDetection', () => {
  /**
   * The completeness claim, asserted rather than trusted. Every character an
   * attacker could hide a host behind has a named entity, and every one of
   * those names is in the table — so this is a closed set, not the first N
   * entries of a list that grows one incident at a time.
   */
  test('every separator that can hide a host decodes', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['&period;', '.'],
      ['&sol;', '/'],
      ['&commat;', '@'],
      ['&colon;', ':'],
      ['&hyphen;', '-'],
      ['&dash;', '-'],
      ['&minus;', '-'],
      ['&lowbar;', '_'],
      ['&percnt;', '%'],
      ['&num;', '#'],
      ['&quest;', '?'],
      ['&equals;', '='],
      ['&amp;', '&'],
      ['&bsol;', '\\'],
      ['&nbsp;', ' '],
      ['&Tab;', '\t'],
      ['&verbar;', '|'],
      ['&lpar;', '('],
      ['&comma;', ','],
      ['&ast;', '*'],
    ];
    for (const [entity, expected] of cases) {
      expect(decodeForDetection(entity), entity).toBe(expected);
    }
  });

  test('the real aliases are all present, because one missing name is one hole', () => {
    expect(decodeForDetection('&lsqb;&lbrack;')).toBe('[[');
    expect(decodeForDetection('&lcub;&lbrace;')).toBe('{{');
    expect(decodeForDetection('&QUOT;&quot;')).toBe('""');
    expect(decodeForDetection('&LT;&lt;&GT;&gt;')).toBe('<<>>');
    expect(decodeForDetection('&vert;&VerticalLine;')).toBe('||');
    expect(decodeForDetection('&lowbar;&UnderBar;')).toBe('__');
  });

  test('numeric entities decode in decimal, hex and with leading zeros', () => {
    expect(decodeForDetection('a&#46;b')).toBe('a.b');
    expect(decodeForDetection('a&#x2E;b')).toBe('a.b');
    expect(decodeForDetection('a&#x2e;b')).toBe('a.b');
    expect(decodeForDetection('a&#046;b')).toBe('a.b');
  });

  /**
   * Where storage decodes exactly once, detection runs to a fixed point: the
   * question is how many wrappers deep the dot is, and the attacker picks that
   * number. `&amp;period;` is the cheapest way to get one extra layer.
   */
  test('decoding runs to a fixed point, unlike the single pass storage takes', () => {
    expect(decodeForDetection('a&amp;period;b')).toBe('a.b');
    expect(decodeForDetection('a&amp;amp;period;b')).toBe('a.b');
    expect(decodeProviderText('a&amp;period;b')).toBe('a&period;b');
  });

  /**
   * The termination guarantee. Each pass strictly shortens the string, so a
   * self-referential input cannot loop — and the cap means even a future table
   * entry that expands rather than contracts stops after four passes.
   */
  test('a self-referential input terminates instead of expanding forever', () => {
    const result = decodeForDetection('&amp;'.repeat(8));
    expect(result).toBe('&'.repeat(8));
  });

  test('an unknown name is left exactly as written', () => {
    expect(decodeForDetection('FOO&bar;BAZ')).toBe('FOO&bar;BAZ');
    expect(decodeForDetection('S&sect;P')).toBe('S&sect;P');
  });

  /**
   * HTML5 entity names are case-sensitive and so is this table. Folding case
   * would make `&Tab;` and a hypothetical `&tab;` collide, and inventing names
   * that the spec does not define is how a decoder starts rewriting data.
   */
  test('a name that HTML5 does not define is not invented', () => {
    expect(decodeForDetection('a&PERIOD;b')).toBe('a&PERIOD;b');
    expect(decodeForDetection('a&Period;b')).toBe('a&Period;b');
  });

  /**
   * HTML5 permits a semicolon-less form only for a fixed legacy list, none of
   * which produces a separator. Decoding them anyway would rewrite ordinary
   * text: `AT&T INC` is a real instrument name.
   */
  test('a bare ampersand is not an entity', () => {
    expect(decodeForDetection('AT&T INC')).toBe('AT&T INC');
    expect(decodeForDetection('Johnson & Johnson')).toBe('Johnson & Johnson');
    expect(decodeForDetection('no entities here')).toBe('no entities here');
  });

  /**
   * Unlike the storage decoder, a control character is produced rather than
   * refused — there is no column to protect, and a NUL smuggled into a name is
   * something a detector should see. Lone surrogates are still skipped because
   * `String.fromCodePoint` throws on them.
   */
  test('a lone surrogate is refused, and the entity is left visible', () => {
    expect(decodeForDetection('A&#xD800;B')).toBe('A&#xD800;B');
    expect(decodeForDetection('A&#x110000;B')).toBe('A&#x110000;B');
  });
});

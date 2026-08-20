import { describe, expect, test } from 'bun:test';
import {
  decodeProviderText,
  decodeProviderTextOptional,
  hasEncodedEntity,
} from '../../src/lib/decode-provider-text';

/**
 * The reported case, and the ways a decoder gets this wrong (SC-276).
 */
describe('the rows mgrin saw on his phone', () => {
  test('the two IBKR instrument names decode', () => {
    expect(decodeProviderText('VANGUARD S&amp;P 500 ETF')).toBe('VANGUARD S&P 500 ETF');
    expect(decodeProviderText('ISHARES CORE S&amp;P US TOTAL MA')).toBe(
      'ISHARES CORE S&P US TOTAL MA'
    );
  });

  test('the subtler entity the ticket names is handled too', () => {
    // `&#39;` in an apostrophe — the one nobody would have reported, because it
    // does not look broken enough to screenshot.
    expect(decodeProviderText('MOODY&#39;S CORP')).toBe("MOODY'S CORP");
    expect(decodeProviderText('MOODY&#x27;S CORP')).toBe("MOODY'S CORP");
  });
});

describe('what it must NOT do', () => {
  test('a bare ampersand is a name, not a broken entity', () => {
    // AT&T is the case that makes a greedy decoder dangerous.
    expect(decodeProviderText('AT&T INC')).toBe('AT&T INC');
    expect(decodeProviderText('Johnson & Johnson')).toBe('Johnson & Johnson');
  });

  test('exactly one pass — a double-escaped entity stops after one', () => {
    // The provider escaped a literal `&amp;`; decoding twice would destroy it
    // and there is no way back.
    expect(decodeProviderText('A&amp;amp;B')).toBe('A&amp;B');
  });

  test('an unknown name is left alone rather than guessed at', () => {
    expect(decodeProviderText('FOO&bar;BAZ')).toBe('FOO&bar;BAZ');
    expect(decodeProviderText('S&sect;P')).toBe('S&sect;P');
  });

  test('a control character is refused, and stays visible as its entity', () => {
    // A provider must not be able to write a NUL or a C0 control into a
    // display column; leaving the entity keeps the oddity findable.
    expect(decodeProviderText('A&#0;B')).toBe('A&#0;B');
    expect(decodeProviderText('A&#7;B')).toBe('A&#7;B');
    expect(decodeProviderText('A&#x1b;B')).toBe('A&#x1b;B');
    // A lone surrogate would make `String.fromCodePoint` throw.
    expect(decodeProviderText('A&#xD800;B')).toBe('A&#xD800;B');
  });

  test('tab and newline are allowed through, being ordinary whitespace', () => {
    expect(decodeProviderText('A&#9;B')).toBe('A\tB');
    expect(decodeProviderText('A&#10;B')).toBe('A\nB');
  });
});

describe('the shape call sites need', () => {
  test('text with no ampersand is returned unchanged, so it is free to call', () => {
    const plain = 'VANGUARD 500 ETF';
    expect(decodeProviderText(plain)).toBe(plain);
  });

  test('null and undefined pass through', () => {
    expect(decodeProviderTextOptional(null)).toBeNull();
    expect(decodeProviderTextOptional(undefined)).toBeUndefined();
    expect(decodeProviderTextOptional('S&amp;P')).toBe('S&P');
  });

  test('hasEncodedEntity reports only a real change', () => {
    expect(hasEncodedEntity('VANGUARD S&amp;P 500 ETF')).toBe(true);
    expect(hasEncodedEntity('AT&T INC')).toBe(false);
    expect(hasEncodedEntity('VANGUARD 500 ETF')).toBe(false);
  });

  test('the other named entities an HTML feed produces', () => {
    expect(decodeProviderText('a &lt; b &gt; c')).toBe('a < b > c');
    expect(decodeProviderText('&quot;quoted&quot;')).toBe('"quoted"');
    expect(decodeProviderText('it&apos;s')).toBe("it's");
    expect(decodeProviderText('a&nbsp;b')).toBe('a b');
    // Case-insensitive on the name, as HTML is.
    expect(decodeProviderText('S&AMP;P')).toBe('S&P');
  });
});

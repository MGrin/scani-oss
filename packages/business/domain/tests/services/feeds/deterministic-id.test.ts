import { describe, expect, test } from 'bun:test';
import { deterministicUuid } from '../../../src/services/feeds/deterministic-id';

const NAMESPACE_DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const NAMESPACE_URL = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const INPUT_ID = '5c149400-0000-4000-8000-000000000001';

describe('deterministicUuid', () => {
  test('the same (namespace, name) always gives the same uuid', () => {
    expect(deterministicUuid(INPUT_ID, 'swap-1')).toBe(deterministicUuid(INPUT_ID, 'swap-1'));
  });

  test('it is a valid v5 uuid', () => {
    const id = deterministicUuid(INPUT_ID, 'swap-1');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('a different name gives a different uuid', () => {
    expect(deterministicUuid(INPUT_ID, 'swap-1')).not.toBe(deterministicUuid(INPUT_ID, 'swap-2'));
  });

  test('a different namespace gives a different uuid for the same name', () => {
    const other = '5c149400-0000-4000-8000-000000000002';
    expect(deterministicUuid(INPUT_ID, 'swap-1')).not.toBe(deterministicUuid(other, 'swap-1'));
  });

  // Vectors computed with Python's `uuid.uuid5`; the first is the one its documentation prints.
  // They prove the bytes (sha1 over the namespace's 16 bytes then the name, UTF-8), not only the shape.
  test.each([
    [NAMESPACE_DNS, 'python.org', '886313e1-3b8a-5372-9b90-0c9aee199e5d'],
    [NAMESPACE_URL, 'https://scani.xyz/feeds', '44c5c88c-c258-50bf-880a-dc0e40bbe296'],
    [NAMESPACE_DNS, '', '4ebd0208-8328-5d69-8c44-ec50939c0967'],
    [NAMESPACE_DNS, 'münchen/€', '77ae2dd3-8047-52c9-a718-905c83278e3e'],
  ])('matches the published vector for (%s, %j)', (namespace, name, expected) => {
    expect(deterministicUuid(namespace, name)).toBe(expected);
  });

  test('an uppercase namespace is the same namespace', () => {
    expect(deterministicUuid(NAMESPACE_DNS.toUpperCase(), 'python.org')).toBe(
      '886313e1-3b8a-5372-9b90-0c9aee199e5d'
    );
  });

  test.each([
    ['an empty string', ''],
    ['a name that is not a uuid', 'dns'],
    ['a uuid with a character outside hex', '6ba7b810-9dad-11d1-80b4-00c04fd430cz'],
    ['a uuid without its hyphens', '6ba7b8109dad11d180b400c04fd430c8'],
    ['a uuid with trailing text', `${NAMESPACE_DNS}x`],
  ])('it throws on %s as the namespace', (_label, namespace) => {
    expect(() => deterministicUuid(namespace, 'x')).toThrow(TypeError);
  });
});

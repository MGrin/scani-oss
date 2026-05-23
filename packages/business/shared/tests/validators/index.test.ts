import { describe, expect, test } from 'bun:test';
import {
  emailSchema,
  hexColorSchema,
  requiredString,
  urlSchema,
  uuidSchema,
} from '../../src/validators';

describe('emailSchema', () => {
  test('accepts valid emails', () => {
    expect(emailSchema.safeParse('user@example.com').success).toBe(true);
    expect(emailSchema.safeParse('  user@example.com  ').success).toBe(true);
  });

  test('rejects empty + bad inputs', () => {
    expect(emailSchema.safeParse('').success).toBe(false);
    expect(emailSchema.safeParse('not-an-email').success).toBe(false);
    expect(emailSchema.safeParse('user@').success).toBe(false);
  });
});

describe('urlSchema', () => {
  test('accepts http(s) URLs', () => {
    expect(urlSchema.safeParse('https://example.com').success).toBe(true);
    expect(urlSchema.safeParse('http://localhost:3000/path?q=1').success).toBe(true);
  });

  test('rejects non-URLs', () => {
    expect(urlSchema.safeParse('').success).toBe(false);
    expect(urlSchema.safeParse('example.com').success).toBe(false);
  });
});

describe('uuidSchema', () => {
  test('accepts valid v4 UUIDs', () => {
    expect(uuidSchema.safeParse('00000000-0000-4000-8000-000000000000').success).toBe(true);
  });

  test('rejects malformed UUIDs', () => {
    expect(uuidSchema.safeParse('not-a-uuid').success).toBe(false);
  });
});

describe('hexColorSchema', () => {
  test('accepts 6- and 3-digit hex', () => {
    expect(hexColorSchema.safeParse('#3b82f6').success).toBe(true);
    expect(hexColorSchema.safeParse('#abc').success).toBe(true);
    expect(hexColorSchema.safeParse('#ABCDEF').success).toBe(true);
  });

  test('rejects bad shapes', () => {
    expect(hexColorSchema.safeParse('3b82f6').success).toBe(false);
    expect(hexColorSchema.safeParse('#xyz').success).toBe(false);
    expect(hexColorSchema.safeParse('#1234567').success).toBe(false);
  });
});

describe('requiredString', () => {
  test('rejects whitespace-only inputs after trim', () => {
    const schema = requiredString('Name');
    expect(schema.safeParse('   ').success).toBe(false);
  });

  test('accepts non-empty trimmed input', () => {
    const schema = requiredString('Name');
    expect(schema.safeParse('hello').success).toBe(true);
  });

  test('error message names the field', () => {
    const schema = requiredString('Vault name');
    const result = schema.safeParse('');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe('Vault name is required');
    }
  });
});

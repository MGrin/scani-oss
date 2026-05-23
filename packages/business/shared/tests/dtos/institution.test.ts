import { describe, expect, test } from 'bun:test';
import { CreateInstitutionDto } from '../../src/dtos/institution';

const VALID_UUID = '00000000-0000-4000-8000-000000000000';

describe('CreateInstitutionDto', () => {
  test('accepts a minimal payload', () => {
    expect(CreateInstitutionDto.safeParse({ name: 'Kraken', typeId: VALID_UUID }).success).toBe(
      true
    );
  });

  test('accepts all optional fields', () => {
    expect(
      CreateInstitutionDto.safeParse({
        name: 'Kraken',
        typeId: VALID_UUID,
        description: 'Crypto exchange',
        website: 'https://kraken.com',
        logoUrl: 'https://example.com/logo.png',
      }).success
    ).toBe(true);
  });

  test('rejects empty name', () => {
    expect(CreateInstitutionDto.safeParse({ name: '', typeId: VALID_UUID }).success).toBe(false);
  });

  test('rejects name over 200 chars', () => {
    expect(
      CreateInstitutionDto.safeParse({ name: 'a'.repeat(201), typeId: VALID_UUID }).success
    ).toBe(false);
  });

  test('rejects non-uuid typeId', () => {
    expect(CreateInstitutionDto.safeParse({ name: 'x', typeId: 'not-a-uuid' }).success).toBe(false);
  });

  test('rejects non-URL website', () => {
    expect(
      CreateInstitutionDto.safeParse({
        name: 'x',
        typeId: VALID_UUID,
        website: 'not-a-url',
      }).success
    ).toBe(false);
  });

  test('rejects non-URL logoUrl', () => {
    expect(
      CreateInstitutionDto.safeParse({
        name: 'x',
        typeId: VALID_UUID,
        logoUrl: 'not-a-url',
      }).success
    ).toBe(false);
  });

  test('rejects description over 500 chars', () => {
    expect(
      CreateInstitutionDto.safeParse({
        name: 'x',
        typeId: VALID_UUID,
        description: 'a'.repeat(501),
      }).success
    ).toBe(false);
  });
});

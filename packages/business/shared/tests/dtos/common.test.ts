import { describe, expect, test } from 'bun:test';
import { IdInputDto } from '../../src/dtos/common';

describe('IdInputDto', () => {
  test('accepts a valid UUID', () => {
    expect(IdInputDto.safeParse({ id: '00000000-0000-4000-8000-000000000000' }).success).toBe(true);
  });

  test('rejects a missing id', () => {
    expect(IdInputDto.safeParse({}).success).toBe(false);
  });

  test('rejects a non-uuid id', () => {
    expect(IdInputDto.safeParse({ id: 'not-a-uuid' }).success).toBe(false);
  });

  test('rejects an empty-string id', () => {
    expect(IdInputDto.safeParse({ id: '' }).success).toBe(false);
  });

  test('rejects a null id', () => {
    expect(IdInputDto.safeParse({ id: null }).success).toBe(false);
  });
});

import { describe, expect, test } from 'bun:test';
import {
  AddValuationDto,
  CreateValuedAssetDto,
  UpdateValuedAssetDetailsDto,
} from '../../src/dtos/valued-asset';

const day = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

const flat = {
  name: 'Lisbon flat',
  currencyCode: 'EUR',
  purchaseDate: '2021-04-12',
  purchasePrice: '310000',
  currentValue: '355000',
  details: { kind: 'property', address: 'Rua X 1', areaSqm: 72 },
};

describe('CreateValuedAssetDto (SC-1643)', () => {
  test('a property parses', () => {
    expect(CreateValuedAssetDto.parse(flat).details).toEqual({
      kind: 'property',
      address: 'Rua X 1',
      areaSqm: 72,
    });
  });

  test('a vehicle parses', () => {
    const car = {
      ...flat,
      name: 'Golf',
      details: { kind: 'vehicle', make: 'VW', model: 'Golf', year: 2019, mileageKm: 48000 },
    };
    expect(CreateValuedAssetDto.parse(car).details.kind).toBe('vehicle');
  });

  test('a property with only its kind parses, with no current value', () => {
    const { currentValue: _, ...rest } = flat;
    expect(
      CreateValuedAssetDto.parse({ ...rest, details: { kind: 'property' } }).currentValue
    ).toBe(undefined);
  });

  test('today is a valid purchase date', () => {
    expect(CreateValuedAssetDto.safeParse({ ...flat, purchaseDate: day(0) }).success).toBe(true);
  });

  test.each([
    ['a purchase date tomorrow', { purchaseDate: day(1) }],
    ['a purchase date that is not a day', { purchaseDate: '2021-04-12T10:00:00Z' }],
    ['a zero purchase price', { purchasePrice: '0' }],
    ['a vehicle from 1800', { details: { kind: 'vehicle', year: 1800 } }],
    ['an unknown kind', { details: { kind: 'boat' } }],
    ['a negative area', { details: { kind: 'property', areaSqm: -1 } }],
  ])('refuses %s', (_label, patch) => {
    expect(CreateValuedAssetDto.safeParse({ ...flat, ...patch }).success).toBe(false);
  });
});

describe('AddValuationDto (SC-1643)', () => {
  const holdingId = '00000000-0000-4000-8000-000000000001';

  test('a valuation today parses', () => {
    expect(AddValuationDto.safeParse({ holdingId, occurredOn: day(0), value: '1' }).success).toBe(
      true
    );
  });

  test('refuses a valuation tomorrow', () => {
    expect(AddValuationDto.safeParse({ holdingId, occurredOn: day(1), value: '1' }).success).toBe(
      false
    );
  });
});

describe('UpdateValuedAssetDetailsDto (SC-1643)', () => {
  test('a rename with details parses', () => {
    const update = {
      holdingId: '00000000-0000-4000-8000-000000000001',
      name: 'Home',
      details: { kind: 'property', areaSqm: 80 },
    };
    expect(UpdateValuedAssetDetailsDto.parse(update).name).toBe('Home');
  });
});

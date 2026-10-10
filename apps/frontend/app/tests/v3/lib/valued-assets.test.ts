import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import {
  buildValuedAssetCreate,
  emptyValuedAssetDraft,
  formatArea,
  formatDistance,
  newestFirst,
  serverDay,
} from '../../../src/v3/lib/valued-assets';

const t = (key: string) => key;

describe('formatArea and formatDistance (SC-1643)', () => {
  test('area is square feet in en-US and square metres elsewhere', () => {
    expect(formatArea(100, 'en-US')).toBe('1,076 ft²');
    expect(formatArea(100, 'de-DE')).toBe('100 m²');
  });

  test('distance is miles in en-US and en-GB and kilometres elsewhere', () => {
    expect(formatDistance(10000, 'en-GB')).toBe('6,214 mi');
    expect(formatDistance(10000, 'en-US')).toBe('6,214 mi');
    expect(formatDistance(10000, 'fr-FR')).toBe(`10${' '}000 km`);
  });
});

describe('buildValuedAssetCreate (SC-1643)', () => {
  const filled = {
    ...emptyValuedAssetDraft('EUR'),
    name: 'Golf',
    purchaseDate: '2019-06-01',
    purchasePrice: '24000',
  };

  test('a vehicle sends its kind and its vehicle details only', () => {
    const built = buildValuedAssetCreate(
      {
        ...filled,
        kind: 'vehicle',
        make: 'VW',
        model: 'Golf',
        year: '2019',
        mileageKm: '48000',
        address: 'x',
      },
      t
    );
    expect(built.blockers).toEqual([]);
    expect(built.payload).toEqual({
      name: 'Golf',
      currencyCode: 'EUR',
      purchaseDate: '2019-06-01',
      purchasePrice: '24000',
      details: { kind: 'vehicle', make: 'VW', model: 'Golf', year: 2019, mileageKm: 48000 },
    });
  });

  test('a property sends its area, and an empty current value is left out', () => {
    const built = buildValuedAssetCreate(
      { ...filled, kind: 'property', areaSqm: '72', currentValue: '' },
      t
    );
    expect(built.payload?.details).toEqual({ kind: 'property', areaSqm: 72 });
    expect(built.payload && 'currentValue' in built.payload).toBe(false);
  });

  test('names what is missing instead of sending', () => {
    const built = buildValuedAssetCreate(emptyValuedAssetDraft('EUR'), t);
    expect(built.payload).toBeNull();
    expect(built.blockers).toEqual([
      'v3.valuedAssets.blocker.name',
      'v3.valuedAssets.blocker.purchaseDate',
      'v3.valuedAssets.blocker.purchasePrice',
    ]);
  });
});

describe('newestFirst (SC-1643)', () => {
  test('orders valuations by when they were recorded, newest first', () => {
    const rows = [
      { on: '2021-04-12', value: '1', recordedAt: '2021-04-12T00:00:00.000Z', replaced: false },
      { on: '2023-06-01', value: '2', recordedAt: '2023-06-01T00:00:00.000Z', replaced: true },
      { on: '2023-06-01', value: '3', recordedAt: '2023-06-01T00:00:00.001Z', replaced: false },
    ];
    expect(newestFirst(rows).map((r) => r.value)).toEqual(['3', '2', '1']);
  });
});

// Review I3: the server's day is UTC; the date field's is the reader's.
describe('serverDay (SC-1643)', () => {
  const at = new Date('2026-10-09T23:30:00Z');
  test("the reader's today is sent as the UTC day it is now", () => {
    expect(serverDay('2026-10-10', '2026-10-10', at)).toBe('2026-10-09');
    expect(serverDay('2026-10-08', '2026-10-08', new Date('2026-10-09T01:00:00Z'))).toBe(
      '2026-10-09'
    );
  });
  test('any other day is sent as picked', () => {
    expect(serverDay('2026-09-01', '2026-10-10', at)).toBe('2026-09-01');
  });
});

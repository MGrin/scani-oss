import type { CreateValuedAsset, ValuedAssetDetails } from '@scani/shared';
import { parsePositivePrice } from './custom-tokens';

/**
 * Property and vehicles valued by hand (SC-1643). Sizes are stored metric and
 * shown in the reader's units: square feet in the US, miles in the US and the
 * UK, metric everywhere else.
 */

const VALUED_ASSET_KINDS = ['property', 'vehicle'] as const;
export type ValuedAssetKind = (typeof VALUED_ASSET_KINDS)[number];

const SQFT_PER_SQM = 10.7639;
const MI_PER_KM = 0.621371;
const IMPERIAL_AREA = new Set(['en-US']);
const IMPERIAL_DISTANCE = new Set(['en-US', 'en-GB']);

const whole = (value: number, locale: string) =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);

export function formatArea(sqm: number, locale: string): string {
  return IMPERIAL_AREA.has(locale)
    ? `${whole(sqm * SQFT_PER_SQM, locale)} ft²`
    : `${whole(sqm, locale)} m²`;
}

export function formatDistance(km: number, locale: string): string {
  return IMPERIAL_DISTANCE.has(locale)
    ? `${whole(km * MI_PER_KM, locale)} mi`
    : `${whole(km, locale)} km`;
}

export function isValuedAssetType(typeCode: string | null | undefined): boolean {
  return (VALUED_ASSET_KINDS as readonly string[]).includes(typeCode ?? '');
}

/** The create form's fields, as typed. Numbers stay strings until they are sent. */
export interface ValuedAssetDraft {
  kind: ValuedAssetKind;
  name: string;
  currencyCode: string;
  purchaseDate: string;
  purchasePrice: string;
  currentValue: string;
  address: string;
  areaSqm: string;
  make: string;
  model: string;
  year: string;
  mileageKm: string;
}

export function emptyValuedAssetDraft(currencyCode: string): ValuedAssetDraft {
  return {
    kind: 'property',
    name: '',
    currencyCode,
    purchaseDate: '',
    purchasePrice: '',
    currentValue: '',
    address: '',
    areaSqm: '',
    make: '',
    model: '',
    year: '',
    mileageKm: '',
  };
}

const text = (value: string) => (value.trim() === '' ? undefined : value.trim());
const number = (value: string) => {
  if (value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

function detailsOf(draft: ValuedAssetDraft): ValuedAssetDetails {
  const fields =
    draft.kind === 'property'
      ? { kind: 'property' as const, address: text(draft.address), areaSqm: number(draft.areaSqm) }
      : {
          kind: 'vehicle' as const,
          make: text(draft.make),
          model: text(draft.model),
          year: number(draft.year),
          mileageKm: number(draft.mileageKm),
        };
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  ) as ValuedAssetDetails;
}

/**
 * The create request, or the sentences naming what is missing — the capture
 * forms' rule: a submit that cannot go says why rather than greying out.
 */
export function buildValuedAssetCreate(
  draft: ValuedAssetDraft,
  t: (key: string) => string
): { payload: CreateValuedAsset | null; blockers: string[] } {
  const blockers = [
    ...(draft.name.trim() === '' ? [t('v3.valuedAssets.blocker.name')] : []),
    ...(draft.purchaseDate === '' ? [t('v3.valuedAssets.blocker.purchaseDate')] : []),
    ...(parsePositivePrice(draft.purchasePrice) === null
      ? [t('v3.valuedAssets.blocker.purchasePrice')]
      : []),
    ...(draft.currentValue.trim() !== '' && parsePositivePrice(draft.currentValue) === null
      ? [t('v3.valuedAssets.blocker.currentValue')]
      : []),
  ];
  if (blockers.length > 0) return { payload: null, blockers };
  return {
    payload: {
      name: draft.name.trim(),
      currencyCode: draft.currencyCode,
      purchaseDate: draft.purchaseDate,
      purchasePrice: draft.purchasePrice.trim(),
      ...(draft.currentValue.trim() ? { currentValue: draft.currentValue.trim() } : {}),
      details: detailsOf(draft),
    },
    blockers,
  };
}

export interface ValuationRow {
  on: string;
  value: string;
  recordedAt: string;
  replaced: boolean;
}

export function newestFirst<T extends ValuationRow>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
}

/**
 * The day to send for a day picked in the date field (review I3). The server
 * keeps days in UTC and refuses one in the future; the field defaults to the
 * reader's local today, which east of UTC is tomorrow there for part of the
 * day, and west of it yesterday. So the reader's today goes as the UTC day it
 * is now, and every other day as picked.
 */
export function serverDay(picked: string, localToday: string, now = new Date()): string {
  return picked === localToday ? now.toISOString().slice(0, 10) : picked;
}

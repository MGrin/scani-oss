import { Decimal } from '@scani/shared';
import type {
  BalanceAt,
  Entry,
  HoldingEvidence,
  Observation,
  PriceAt,
  PriceGranularity,
  PricePath,
  PriceReading,
} from '../../src/engine/types';

type ObservationFields = Partial<Omit<Observation, 'id' | 'at' | 'amount'>>;
type EntryFields = Partial<Omit<Entry, 'id' | 'at' | 'quantity'>>;
type DerivedBalance = Extract<BalanceAt, { status: 'derived' }>;

export function utc(date: string, time = '00:00'): Date {
  return new Date(`${date}T${time}:00.000Z`);
}

export const STARTS_AT = utc('2026-01-01');

function observation(
  id: string,
  at: Date,
  amount: string,
  defaults: Pick<Observation, 'role' | 'authority' | 'cause'>,
  fields: ObservationFields
): Observation {
  return {
    id,
    at,
    amount,
    ...defaults,
    inputId: null,
    supersededAt: null,
    recordedAt: at,
    ...fields,
  };
}

export function snap(id: string, at: Date, amount: string, fields: ObservationFields = {}) {
  return observation(
    id,
    at,
    amount,
    { role: 'snapshot', authority: 'person', cause: 'flow' },
    fields
  );
}

export function checkpoint(id: string, at: Date, amount: string, fields: ObservationFields = {}) {
  return observation(
    id,
    at,
    amount,
    { role: 'checkpoint', authority: 'provider', cause: null },
    fields
  );
}

export function verification(id: string, at: Date, amount: string, fields: ObservationFields = {}) {
  return observation(
    id,
    at,
    amount,
    { role: 'verification', authority: 'person', cause: null },
    fields
  );
}

export function entry(id: string, at: Date, quantity: string, fields: EntryFields = {}): Entry {
  return {
    id,
    at,
    quantity,
    kind: quantity.startsWith('-') ? 'outflow' : 'inflow',
    kindOrigin: 'source',
    inputId: null,
    ...fields,
  };
}

export function evidence(fields: Partial<HoldingEvidence> = {}): HoldingEvidence {
  return {
    holdingId: 'holding-1',
    kind: 'snapshot',
    startsAt: STARTS_AT,
    observations: [],
    entries: [],
    windows: [],
    ...fields,
  };
}

export function derived(result: BalanceAt): DerivedBalance {
  if (result.status !== 'derived')
    throw new Error(`expected a derived balance, got '${result.status}'`);
  return result;
}

export function priceReading(
  tokenId: string,
  baseTokenId: string,
  price: string,
  at: Date,
  granularity: PriceGranularity = 'intraday',
  source: string | null = null
): PriceReading {
  return { tokenId, baseTokenId, price, at, granularity, source };
}

/** A `priceAt` answer, for a test that starts from what the engine said. */
export function quoted(
  price: string,
  readingAt: Date,
  path: PricePath,
  stale = false,
  source: string | null = null
): PriceAt {
  return { price: new Decimal(price), readingAt, path, stale, source };
}

/** Seeded Fisher–Yates (MINSTD), so a failing order reproduces. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i--) {
    state = (state * 48271) % 2147483647;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

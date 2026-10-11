// SC-1645: the order the wrapper picker lists its codes in.

export type WrapperRegion = 'us' | 'uk' | 'ca' | 'au' | 'eu';

export interface WrapperRow {
  code: string;
  region: WrapperRegion | null;
  treatment: string;
  displayOrder: number;
}

const REGION_ORDER: readonly WrapperRegion[] = ['us', 'uk', 'ca', 'au', 'eu'];

const REGION_OF_CURRENCY: Readonly<Record<string, WrapperRegion>> = {
  USD: 'us',
  GBP: 'uk',
  CAD: 'ca',
  AUD: 'au',
  EUR: 'eu',
  CHF: 'eu',
};

export function regionOfCurrency(code: string): WrapperRegion | null {
  return REGION_OF_CURRENCY[code.toUpperCase()] ?? null;
}

/** The user's region first, then the codes valid anywhere, then the other regions. */
export function orderWrappers(
  rows: readonly WrapperRow[],
  region: WrapperRegion | null
): { region: WrapperRegion | null; codes: string[] }[] {
  const order: (WrapperRegion | null)[] = region
    ? [region, null, ...REGION_ORDER.filter((r) => r !== region)]
    : [null, ...REGION_ORDER];
  return order
    .map((r) => ({
      region: r,
      codes: [...rows]
        .filter((row) => row.region === r)
        .sort((a, b) => a.displayOrder - b.displayOrder)
        .map((row) => row.code),
    }))
    .filter((group) => group.codes.length > 0);
}

// SC-1645: gains grouped by the bucket of each account's wrapper.

const WRAPPER_TREATMENTS = ['general', 'deferred', 'exempt', 'advantaged'] as const;
type WrapperTreatment = (typeof WRAPPER_TREATMENTS)[number];

export type WrapperGainsSummary =
  | { status: 'rebuilding'; anyWrapped: boolean }
  | {
      status: 'ok';
      buckets: {
        treatment: WrapperTreatment;
        realized: string;
        unrealized: string;
        accountCount: number;
      }[];
      anyWrapped: boolean;
      carriedHoldings: number;
    };

export interface WrapperGainsRow {
  treatment: WrapperTreatment;
  realized: number;
  unrealized: number;
  total: number;
}

export interface WrapperGainsView {
  /** A history rebuild is running, so the rows may mix two walks (feeds, bus #24470). */
  withheld: boolean;
  /** The wrapped buckets, in the tile's order: largest gain or loss first. */
  rows: WrapperGainsRow[];
  /** Apart from `rows`: the tile leaves it out, so the peek lists it last. */
  general: WrapperGainsRow | null;
  /** Realized plus unrealized over every bucket but `general`; null while withheld. */
  wrappedGain: number | null;
  wrappedTreatments: WrapperTreatment[];
  carriedHoldings: number;
}

/** Null when no account has a wrapper: a tile reading "all General" says nothing. */
export function toWrapperGainsView(
  summary: WrapperGainsSummary | null | undefined
): WrapperGainsView | null {
  if (!summary?.anyWrapped) return null;
  if (summary.status === 'rebuilding') {
    return {
      withheld: true,
      rows: [],
      general: null,
      wrappedGain: null,
      wrappedTreatments: [],
      carriedHoldings: 0,
    };
  }
  const all = WRAPPER_TREATMENTS.flatMap((treatment) => {
    const bucket = summary.buckets.find((b) => b.treatment === treatment);
    if (!bucket || bucket.accountCount === 0) return [];
    const realized = Number(bucket.realized);
    const unrealized = Number(bucket.unrealized);
    return [{ treatment, realized, unrealized, total: realized + unrealized }];
  });
  const rows = all
    .filter((row) => row.treatment !== 'general')
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  return {
    withheld: false,
    rows,
    general: all.find((row) => row.treatment === 'general') ?? null,
    wrappedGain: rows.reduce((sum, row) => sum + row.total, 0),
    wrappedTreatments: rows.map((row) => row.treatment),
    carriedHoldings: summary.carriedHoldings,
  };
}

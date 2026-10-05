import type { Decimal } from '@scani/shared';

const HOLDING_KINDS = ['snapshot', 'feed'] as const;
export type HoldingKind = (typeof HOLDING_KINDS)[number];

const OBSERVATION_ROLES = ['snapshot', 'checkpoint', 'verification'] as const;
export type ObservationRole = (typeof OBSERVATION_ROLES)[number];

/** Index 0 ranks highest. */
export const AUTHORITIES = ['provider', 'statement', 'person'] as const;
export type Authority = (typeof AUTHORITIES)[number];

const SNAPSHOT_CAUSES = ['flow', 'growth', 'correction'] as const;
export type SnapshotCause = (typeof SNAPSHOT_CAUSES)[number];

export const LEDGER_KINDS = [
  'inflow',
  'outflow',
  'transfer_in',
  'transfer_out',
  'trade_leg',
  'fee',
  'income',
  'corporate_action',
  'derivative_pnl',
  'unexplained_difference',
] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

const KIND_ORIGINS = ['source', 'rule', 'jev', 'person', 'mirror'] as const;
export type KindOrigin = (typeof KIND_ORIGINS)[number];

/** Index 0 ranks highest. */
export const PRICE_GRANULARITIES = ['tx-exact', 'intraday', 'daily'] as const;
export type PriceGranularity = (typeof PRICE_GRANULARITIES)[number];

export interface Observation {
  id: string;
  at: Date;
  amount: string;
  role: ObservationRole;
  authority: Authority;
  cause: SnapshotCause | null;
  inputId: string | null;
  supersededAt: Date | null;
  recordedAt: Date;
}

export interface Entry {
  id: string;
  at: Date;
  quantity: string;
  kind: LedgerKind | null;
  kindOrigin: KindOrigin | null;
  inputId: string | null;
}

export interface InputWindow {
  inputId: string;
  from: Date | null;
  to: Date;
}

export interface HoldingEvidence {
  holdingId: string;
  kind: HoldingKind;
  startsAt: Date;
  observations: readonly Observation[];
  entries: readonly Entry[];
  windows: readonly InputWindow[];
}

export type BalanceMethod = 'forward' | 'walk-back' | 'first-snapshot' | 'no-anchor';

export type BalanceAt =
  | { status: 'absent' }
  | {
      status: 'derived';
      balance: Decimal;
      method: BalanceMethod;
      anchorId: string | null;
      anchorAt: Date | null;
      entriesApplied: number;
    };

export interface PriceReading {
  tokenId: string;
  baseTokenId: string;
  price: string;
  at: Date;
  granularity: PriceGranularity;
  source: string | null;
}

export type AssetClass = 'crypto' | 'fiat' | 'stock' | 'custom' | 'unknown';

export interface PriceEvidence {
  readings: readonly PriceReading[];
  hubTokenIds: readonly string[];
  /** Per asset: the currencies it has a forward reading in, besides the base and the hubs. */
  quoteTokenIds?: ReadonlyMap<string, readonly string[]>;
  /** The class of each hub and quote token. A missing one is 'unknown'. */
  assetClasses?: ReadonlyMap<string, AssetClass>;
}

export interface PriceAsset {
  tokenId: string;
  assetClass: AssetClass;
}

/** A price asked for: one token at one instant. */
export interface PriceAsk {
  tokenId: string;
  at: Date;
}

/** `quote:Q` when the second leg is direct, `quote:Q:H` when it goes through hub H. */
export type PricePath = 'identity' | 'direct' | 'inverse' | `hub:${string}` | `quote:${string}`;

/** `source` is the asset's own reading's: the first leg of a routed answer. Null for identity. */
export interface PriceAt {
  price: Decimal;
  readingAt: Date;
  path: PricePath;
  stale: boolean;
  source: string | null;
}

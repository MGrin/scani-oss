import { z } from 'zod';
import { Decimal, isValidDecimalString } from '../decimal';

export type Holding = {
  id: string;
  createdAt: Date;
  tokenId: string;
  userId: string;
  balance: string;
  accountId: string;
  lastUpdated: Date;
};

/**
 * A holding extracted from a file or screenshot — the shape the
 * file-import pipeline (csv/ofx/qif parsers + AI screenshot parsing)
 * produces before the review screen turns it into a real `Holding`.
 *
 * Lives in shared so the worker's return value and the frontend's
 * review page agree on fields. The frontend extends this with
 * `tokenId`, `holdingId`, `clientId` etc. for its own state.
 */
export interface ExtractedHolding {
  /** Currency code (USD, EUR) or stock ticker (AAPL) */
  symbol: string;
  /** Human-readable name */
  name?: string;
  /** Balance as string for decimal precision */
  balance: string;
  /** Confidence 0-1 */
  confidence: number;
  /** Extra context */
  notes?: string;
}

export const CreateHoldingDto = z.object({
  accountId: z.string().uuid(),
  tokenId: z.string().uuid(),
  balance: z.string().refine(
    (val) => {
      if (!isValidDecimalString(val)) return false;
      return new Decimal(val).greaterThanOrEqualTo(0);
    },
    {
      message: 'Balance must be a valid decimal number string that is non-negative',
    }
  ),
  lastUpdated: z.date().optional(),
});

export const UpdateHoldingDto = z.object({
  balance: z
    .string()
    .refine(
      (val) => {
        if (!isValidDecimalString(val)) return false;
        return new Decimal(val).greaterThanOrEqualTo(0);
      },
      {
        message: 'Balance must be a valid decimal number string that is non-negative',
      }
    )
    .optional(),
  isActive: z.boolean().optional(),
});

export type HoldingWithDetails = {
  id: string;
  /**
   * What the user calls this pot, when their account holds several rows for
   * one token (SC-330). Null on every ordinary holding, and on every synced
   * one — an importer addresses a position by `external_id` and has no name
   * to give it. Present on the wire because four rows reading `RUB · Tinkoff`
   * are four rows the user cannot tell apart, which is how the second upload
   * of that screen proposed the wrong balance for the wrong pot.
   */
  label?: string | null;
  token: {
    id: string;
    symbol: string;
    name: string;
    type: string;
    typeCode: string;
    iconUrl?: string | null;
    /** 0..1. `>= SCAM_PROBABILITY_THRESHOLD` → rendered with the scam badge. */
    isScamProbability: number;
    /**
     * The ASCII symbol this token's symbol DRAWS but is not — `UЅDС`
     * (Cyrillic Ѕ and С) carries `USDC`. Null means the symbol is plain
     * ASCII and reads as itself.
     *
     * On the wire because the row is otherwise indistinguishable from the
     * real one, which is the entire harm (SC-197). A non-null value here
     * is a fact about the CHARACTERS, established once at creation and
     * never re-scored — unlike `isScamProbability`, which moves with our
     * own pricing coverage (SC-207). Do not conflate the two: a token can
     * be a lookalike with a low scam score, and most unpriced tokens are
     * not lookalikes at all.
     */
    lookalikeOf?: string | null;
  };
  amount: number;
  // `null` when the holding's token has no resolvable price in the
  // user's base currency. UI renders "—" rather than $0 so the
  // missing-data state is visible.
  value: number | null;
  costBasis: number | null;
  price?: {
    // `null` for the same reason as `value`. When present, the value
    // string is the per-unit price; when null, only timestamp/source
    // are still meaningful (e.g. last-known-source metadata).
    value: string | null;
    timestamp: string;
    source?: string;
  };
  account: {
    id: string;
    name: string;
    type: string;
    typeCode: string;
    institutionId: string;
  };
  institution: {
    id: string;
    name: string;
    type: string;
    typeCode: string;
    website?: string | null;
  };
  groups: Array<{
    id: string;
    name: string;
    color: string;
  }>;
  lastUpdated: string;
  createdAt: string;
  isActive: boolean;
  isHidden: boolean;
  source: string;
  apyConfig?: {
    id: string;
    annualRatePct: string;
    payoutFrequency: string;
    payoutDayOfWeek: number | null;
    payoutDayOfMonth: number | null;
    payoutMonth: number | null;
    lastPayoutAt: string | null;
    isActive: boolean;
  };
  /**
   * Set when the import flow couldn't gather a complete tx history for
   * this holding (e.g. Helius's parsed-tx index truncates older Solana
   * transactions, an exchange CSV starts mid-history, an API token
   * lacks deep-history scope). The `BalanceAtTimeService` clamps the
   * resulting negative reconstructed balance at zero on the chart, so
   * without this flag the user sees a clean curve that hides a known
   * reconciliation gap. Surface it in the UI as a "missing earlier
   * history" badge so the user can re-import or accept.
   *
   * `missingQuantity` is the absolute opening-balance shortfall from
   * `holding_coverage.opening_balance_quantity` (a negative value
   * means the synthesized opening balance was negative, i.e. the
   * import implies inflows we never saw).
   */
  dataIntegrity?: {
    incompleteHistory: boolean;
    missingQuantity?: string;
    note?: string;
  };
  /**
   * True when this holding's token is unpriceable **in fact**: it has never
   * had a single `token_prices` row and is currently inside an unpriceable
   * cooldown — `TokenRepository.findNeverPricedInCooldownTokenIds`, the same
   * predicate the net-worth chart uses to leave it out of the coverage
   * denominator (SC-146).
   *
   * It exists because `value === null` is two different facts wearing one
   * face. "We failed to fetch a price for this today" and "no provider has
   * ever quoted this token and we have stopped asking" both render as a dash,
   * and only the second is permanent. The chart can say how many holdings it
   * set aside but not which, so the list is where the reader finds out
   * (SC-154).
   *
   * Absent rather than `false` on a priceable holding: the flag is an
   * exception, and 14 rows out of 200 carrying it is the shape of the wire
   * payload too.
   */
  unpriceable?: boolean;
};

export type HoldingsWithSummary = {
  holdings: HoldingWithDetails[];
  summary: {
    totalCount: number;
    activeCount: number;
    totalValue: string;
  };
};

export type CreateHoldingInput = z.infer<typeof CreateHoldingDto>;
export type UpdateHoldingInput = z.infer<typeof UpdateHoldingDto>;

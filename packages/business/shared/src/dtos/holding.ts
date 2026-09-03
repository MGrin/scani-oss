import { z } from 'zod';
import { Decimal, isValidDecimalString } from '../decimal';
import { MANUAL_EDIT_CAUSES, type ManualEditCause } from '../lib/manual-balance-edit';
import { manualOutflowAnswerSchema } from './transfer-review';

/**
 * A pot name is a label on a row in a list, not a description. Long enough for
 * "Wedding gift" and "Deposit 12 months", short enough that the holdings list
 * still reads as a list.
 *
 * Lives here rather than in `batch.ts` because both the create payload and the
 * update payload bound a label by it, and `batch.ts` already depends on this
 * file. Every consumer imports it from the `@scani/shared` barrel, so which of
 * the two files holds it is invisible from outside.
 */
export const HOLDING_LABEL_MAX_LENGTH = 40;

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
  /**
   * What the user calls this pot (SC-330), settable on a holding that already
   * exists (SC-564).
   *
   * The column, the render and the create-time write all shipped with SC-330;
   * this is the only path that was missing, which is why every holding that
   * predated it was stuck with a NULL label and no way to change that. The RUB
   * rows the pot name was designed for were created before the column existed,
   * so they could never acquire one.
   *
   * `null` clears the name. `undefined` leaves it alone — the distinction
   * matters because most updates here are balance edits that must not touch
   * it. Trimmed at the boundary so the position key and the stored value
   * agree on what " Savings " is, exactly as `CreateHoldingsWithDependenciesDto`
   * does.
   */
  label: z.string().trim().max(HOLDING_LABEL_MAX_LENGTH).nullable().optional(),
  /**
   * What the balance edit MEANT (SC-510). Required when the holding's token
   * type is ambiguous (`manualEditNeedsCause`) and no per-holding default has
   * been remembered; ignored when `balance` is absent.
   *
   * Optional on the wire rather than required because most edits do not carry
   * one — an unambiguous holding's cause is derived server-side and an
   * `isActive` toggle has none. The server refuses the one combination it
   * cannot answer for itself rather than guessing.
   */
  editCause: z.enum(MANUAL_EDIT_CAUSES).optional(),
  /**
   * WHEN the flow happened, ISO-8601. Pre-filled with today by the client and
   * editable, because the user knows when they moved the money and the system
   * never will.
   *
   * Dating everything at the edit instant was explicitly rejected: it
   * concentrates months of flow onto one date and distorts time-weighted
   * return around it — the failure `e1fa63e5` removed ("stop one day absorbing
   * ten weeks"). Spreading the delta across the gap was rejected too; it
   * invents a schedule that never happened.
   *
   * Only read for `editCause: 'flow'`. A correction is dated by the server at
   * the moment the superseded figure entered the record, and growth writes no
   * ledger row at all.
   */
  editOccurredAt: z.string().datetime({ offset: true }).optional(),
  /**
   * Where the money WENT, for a `flow` that takes the balance DOWN (SC-606).
   *
   * The transfer-review queue's own question, answered at the moment the user
   * is already being asked what the edit meant, so that answering does not
   * manufacture the next question. `MANUAL_OUTFLOW_DESTINATIONS` carries the
   * reasoning and why `paired` is not among the choices.
   *
   * Optional, and its absence is not a defect: a positive delta is owed no
   * answer, a `correction` or `growth` writes no outflow to answer about, and
   * a client that sends nothing leaves the row in the queue exactly as it
   * behaved before this shipped. The server does not infer one — a guess here
   * is a disposal booked or not booked on nobody's authority.
   */
  editOutflow: manualOutflowAnswerSchema.optional(),
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
  /**
   * The unit count, as a decimal string — the same reason `balance` above is
   * one, and `price.value` and `totalValue` below.
   *
   * It was a `number` rounded to 8 decimals, which lost both ends: every
   * balance under `1e-8` arrived as `0` — a claim that the position is EMPTY
   * rather than small — and a double silently dropped the low digits of a
   * large one. Neither loss was visible to the reader (SC-567).
   */
  amount: string;
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
   *
   * The flag says the shortfall EXISTS; `historyStartsAt` says whether
   * anything is known about why (SC-900).
   */
  dataIntegrity?: {
    incompleteHistory: boolean;
    missingQuantity?: string;
    note?: string;
    /**
     * The earliest date this holding's ledger SOURCE covers, ISO-8601, when
     * one has been stated (SC-900).
     *
     * Its presence is what separates two readings of the identical shortfall:
     * *we cannot account for this*, which is worth investigating, and *this
     * predates the earliest statement obtainable*, which was settled the
     * moment a date range was chosen in the broker's report editor. Both were
     * the same sentence until now, so every audit that met the second one
     * re-opened it.
     *
     * Absent — not null — when no source has stated a window, and absence must
     * be read as "unknown" rather than "the ledger reaches the beginning".
     * Sent as a DATE rather than a rendered phrase because the client formats
     * and translates it; the server's `note` carries the English long form for
     * a client that has neither.
     */
    historyStartsAt?: string;
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
  /**
   * The price behind `value` is older than the freshness window its
   * granularity is held to — `MAX_INTRADAY_PRICE_AGE_MS` for an intraday row,
   * `MAX_DAILY_PRICE_AGE_MS` for a daily close, both unchanged and both
   * carrying their reasoning in `@scani/domain`'s `constants.ts` (SC-956).
   *
   * The sibling of `unpriceable` above, and on the wire beside it rather than
   * inside `price` for that reason: both answer "why is this figure weaker
   * than it looks", the same two surfaces read them together, and splitting
   * the pair across two levels would make them read as unrelated facts.
   *
   * They are NOT the same fact and neither implies the other. `unpriceable`
   * means nobody has ever quoted this token and the value is absent; this
   * means somebody quoted it, the value is present and counted, and the quote
   * is old. `value` stays in every total either way — flagging a stale price
   * rather than dropping the holding is a decision the rollup already made and
   * wrote down, because dropping it fabricates a hole on a pure data-gap day.
   *
   * THREE STATES, and `undefined` is not "fresh". It means no `token_prices`
   * row was found to date this price, so the question could not be asked —
   * which is a different thing from asking it and getting no. Unlike
   * `unpriceable`, whose absence is merely the common case, an absence here
   * carries information, so it is not compressed to "absent means false".
   */
  priceStale?: boolean;
  /**
   * The last answer this holding's owner gave to "what did that edit mean"
   * (SC-510), or null if they have never been asked. The client pre-selects
   * it so the second month of a monthly savings update is one tap.
   *
   * A remembered DEFAULT, never a silent one: it is only ever written by a
   * user answering the question, so a holding that has never been answered
   * for stays null and the client must ask. That is the whole difference
   * between this and a system-chosen default, which is wrong for at least one
   * of the three causes permanently and renders as a plausible number.
   */
  manualEditCause?: ManualEditCause | null;
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

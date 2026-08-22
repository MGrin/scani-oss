import { z } from 'zod';
import {
  BALANCE_GAP_ANSWERS,
  BALANCE_GAP_SUPPRESSIONS,
  type BalanceGapSuppression,
} from '../lib/balance-gap';

/**
 * The wire shape of one unexplained balance change (SC-501).
 *
 * ## Why the observation is the identity
 *
 * A gap is a PAIR of observations, and the pair is determined by the later
 * one: its predecessor is whatever sits before it on the same holding. So the
 * closing observation's id is the whole key, and there is no second row to
 * create, no composite to keep in sync, and nothing to write before the owner
 * answers.
 *
 * That is also what makes the two legs of an untracked transfer symmetrical.
 * The arrival at the destination already has a synthesized `opening_balance`
 * row and the departure at the source has no ledger row at all — an asymmetry
 * that makes "edit the existing row" impossible for one of them. Both legs
 * have two balance observations, so both are addressable the same way.
 *
 * ## Figures are decimal strings
 *
 * `drift`, `previousBalance` and `balance` are token quantities at full
 * precision; `baseValue` is the priced figure the threshold was applied to.
 * None of them goes near a float — an 18-decimal crypto quantity does not
 * survive one, and `baseValue` is what the owner is shown.
 */
export const balanceGapSchema = z.object({
  /** The CLOSING observation of the pair. See above. */
  observationId: z.string().uuid(),
  holdingId: z.string().uuid(),
  /** For the row's subject line — the client names it, this does not. */
  tokenSymbol: z.string().min(1),
  /**
   * `token_types.code`. On the wire because the CARD decides the precision of
   * the two balances it prints, and it cannot without knowing whether this
   * balance is an amount of money or a count of things (SC-576). See
   * `balanceDecimals`.
   */
  tokenTypeCode: z.string().min(1),
  accountName: z.string().min(1).nullable(),
  /**
   * The interval, as ISO strings.
   *
   * Strings rather than `z.date()` because this router runs without a
   * transformer, so a `Date` arrives at the client as a string anyway and a
   * `z.date()` on the wire is a type the client never actually holds — the
   * same choice `transfer-review.ts` makes for `occurredAt`.
   *
   * They are also the BOUNDS on the answer's date: see `answerBalanceGapSchema`.
   */
  from: z.string().datetime(),
  to: z.string().datetime(),
  previousBalance: z.string().min(1),
  balance: z.string().min(1),
  /**
   * `balance − previousBalance − Σ transactions in (from, to]`, signed.
   * Positive means money appeared; negative means it left.
   */
  drift: z.string().min(1),
  /** `|drift|` priced into the owner's base currency at `to`. */
  baseValue: z.string().min(1),
  baseCurrency: z.string().length(3),
  /**
   * How many transactions the ledger DID have for this interval. Zero is the
   * common case and the interesting one; a non-zero count means the ledger
   * explained part of the change and this is the remainder.
   */
  transactionsApplied: z.number().int().nonnegative(),
  /**
   * Whether to ask the owner WHEN, as well as what.
   *
   * False on a short interval, where the two observations already date the
   * movement to the hour and a date-only answer would be less precise than
   * what we hold. See `BALANCE_GAP_DATE_PROMPT_MIN_SPAN_MS`.
   */
  datePrompted: z.boolean(),
});

export type BalanceGap = z.infer<typeof balanceGapSchema>;

export const balanceGapAnswerSchema = z.enum(BALANCE_GAP_ANSWERS);

/**
 * Why gaps were left out of the list, one count per reason.
 *
 * Sent to the client and logged on the server. A queue that quietly drops
 * rows and reports only what survived cannot be told apart from a query that
 * missed them, and the difference matters most on the day somebody says "you
 * did not ask me about the big one".
 */
export const balanceGapSuppressionsSchema = z.object(
  Object.fromEntries(
    BALANCE_GAP_SUPPRESSIONS.map((reason) => [reason, z.number().int().nonnegative()])
  ) as Record<BalanceGapSuppression, z.ZodNumber>
);

export type BalanceGapSuppressions = z.infer<typeof balanceGapSuppressionsSchema>;

export const balanceGapListSchema = z.object({
  items: z.array(balanceGapSchema),
  /** Every gap found before any suppression ran. */
  examined: z.number().int().nonnegative(),
  suppressed: balanceGapSuppressionsSchema,
});

export type BalanceGapList = z.infer<typeof balanceGapListSchema>;

/**
 * Answering one gap.
 *
 * `occurredAt` is read for `flow` alone and is the whole point of the
 * feature: the owner supplies the date, so the claim about when the money
 * moved is theirs. A `correction` is dated by the server at the moment the
 * superseded figure entered the record, and `growth` and `unknown` write no
 * dated row at all — asking for a date on any of those would invite "today",
 * which is when it was noticed rather than when it happened.
 *
 * ## The date is CLAMPED into the interval, never refused
 *
 * The two observations prove the balance changed between them; that is
 * stronger evidence than a recollection of which day it was, and it is also
 * what the value walk applies. A flow written outside the interval lands in a
 * DIFFERENT one, where it becomes that interval's unexplained drift with the
 * opposite sign — so answering one gap would manufacture another while
 * leaving this one unexplained under a stamp saying it was handled.
 *
 * Refusing the date was the first design and it was wrong. A date field
 * collects a day, a day becomes an instant at LOCAL MIDNIGHT, and the
 * measured consequence (production, 2026-08-22, owner in UTC+8) is that an
 * honest date-only answer lands fourteen hours before the hour it explains.
 * A bound would have refused nearly every real answer.
 *
 * So the instant is clamped into `(from, to]` and the day the owner picked
 * chooses where inside. On an interval too short for a day to mean anything,
 * `occurredAt` is not asked for at all and the closing observation is used —
 * see `datePrompted` on `balanceGapSchema`.
 */
export const answerBalanceGapSchema = z.object({
  observationId: z.string().uuid(),
  answer: balanceGapAnswerSchema,
  /**
   * Optional even for `flow`. A short interval is not asked about at all, and
   * the server falls back to the closing observation — which is a better
   * answer than the one a date field could have collected.
   */
  occurredAt: z.coerce.date().optional(),
});

export type AnswerBalanceGapInput = z.infer<typeof answerBalanceGapSchema>;

/**
 * Why an answer was refused, in terms the API turns into a status.
 *
 * `already-answered` is separate from `gone` deliberately: two tabs open on
 * the same queue is an ordinary thing, and "somebody already answered this"
 * is a different sentence from "that holding no longer exists".
 */
export const BALANCE_GAP_REFUSALS = ['gone', 'already-answered', 'no-longer-a-gap'] as const;

export type BalanceGapRefusal = (typeof BALANCE_GAP_REFUSALS)[number];

export const answerBalanceGapResultSchema = z.object({
  observationId: z.string().uuid(),
  answer: balanceGapAnswerSchema,
  /** The ledger row written, or null for `growth` and `unknown`. */
  wroteKind: z.enum(['deposit', 'withdraw', 'correction']).nullable(),
  /**
   * The instant the row was actually stamped with, when one was written.
   *
   * Returned rather than assumed because it is not always the date the owner
   * sent: a day outside the interval is clamped into it. Saying so is the
   * difference between a clamp and a silent rewrite of somebody's answer.
   */
  occurredAt: z.string().datetime().nullable(),
});

export type AnswerBalanceGapResult = z.infer<typeof answerBalanceGapResultSchema>;

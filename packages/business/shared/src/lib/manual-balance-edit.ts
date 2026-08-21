/**
 * What a manual balance edit MEANT, and which holdings we may answer that
 * question for without asking (SC-510).
 *
 * ## The problem this exists for
 *
 * A manual account has no transaction ledger. The user edits a holding's
 * amount, the balance moves, and until SC-510 nothing was written to
 * `holding_transactions` — so the delta reached the value series with no flow
 * to net it out and the returns engine read the whole of it as performance.
 * Add £5,000 to a manual holding and the engine reports a £5,000 gain.
 *
 * ## Why it cannot simply be synthesized
 *
 * The delta is observable; its CAUSE is not, and there are three of them:
 *
 * * **flow** — money was added or removed. A contribution, excluded from
 *   return.
 * * **correction** — the previous figure was wrong. A restatement: neither a
 *   contribution nor performance.
 * * **growth** — an unpriced balance grew by interest or revaluation. This IS
 *   performance.
 *
 * Booking every edit as a flow is worse than the bug it replaces. A
 * manually-tracked savings account earns its return THROUGH the balance edit —
 * there is no other signal — so that account would return exactly 0% forever.
 * The current bug prints −39% and screams; that one prints a flat, plausible,
 * wrong number nobody questions.
 *
 * ## The split, and the rule behind it
 *
 * A quantity edit is unambiguously a **flow** exactly when performance can
 * reach the holding through a channel OTHER than the number being edited.
 * Where a market price is fetched and the user is editing a share/coin count,
 * revaluation already arrives through that price: 10 shares becoming 15 is a
 * purchase, full stop.
 *
 * That is not the same as "we hold a price for it", and the difference is
 * `fiat`. We fetch an FX rate for every currency, so a EUR holding in a GBP
 * portfolio is priced — but the quantity IS the money, so interest credited
 * to it arrives as a quantity change indistinguishable from a deposit. FX
 * moves the value; interest does not reach us any other way.
 *
 * So the AUTOMATIC set is exactly `crypto` and `stock`, and everything else
 * asks: `fiat` because the quantity is the money, `private-company` and
 * `other` because `PricingProviderRouter` maps both to `null` and their price
 * only ever moves because a human typed it, and any type an admin adds later
 * because nobody has thought about it yet.
 *
 * Measured on the local realistic portfolio (19 holdings, 2026-08-21): 15
 * unambiguous (7 crypto + 8 stock), 4 ambiguous (3 fiat + 1 private-company).
 *
 * The split is deliberately asymmetric in its failure. Wrongly automatic
 * writes a silent phantom flow or erases a real return; wrongly ambiguous
 * asks a question the user finds obvious. Only the first is a wrong number.
 */

/** The three things a manual balance delta can mean. */
export const MANUAL_EDIT_CAUSES = ['flow', 'correction', 'growth'] as const;

export type ManualEditCause = (typeof MANUAL_EDIT_CAUSES)[number];

export function isManualEditCause(value: unknown): value is ManualEditCause {
  return typeof value === 'string' && (MANUAL_EDIT_CAUSES as readonly string[]).includes(value);
}

/**
 * The only token types whose balance edit we may classify WITHOUT asking.
 *
 * Both have an external pricing provider AND a quantity that is a count of
 * things rather than an amount of money, so revaluation reaches the holding
 * through the price and the quantity is left carrying nothing but flow.
 *
 * Named positively, and that direction is the whole safety property. The set
 * that ASKS is everything else — `fiat`, `private-company`, `other`, and any
 * type an admin adds to `token_types` tomorrow without a migration. Written
 * the other way round, as a list of ambiguous types, a new type would default
 * to AUTOMATIC and be silently classified from the day it first appeared;
 * this way it defaults to a question.
 *
 * The asymmetry is why it is worth the inversion. Wrongly automatic writes a
 * phantom flow or erases a real return, and renders as a plausible number.
 * Wrongly ambiguous asks a question the user finds obvious.
 *
 * `flowRoleOf` reasons identically and lands on the opposite shape, for the
 * same reason: there, the safe fallback is `external`, so the named set is
 * the unsafe one.
 */
const UNAMBIGUOUS_TOKEN_TYPE_CODES: ReadonlySet<string> = new Set(['crypto', 'stock']);

/**
 * Does a balance edit on a holding of this token type need the user to say
 * what it meant?
 *
 * The single definition, shared by the API (which refuses to guess) and the
 * SPA (which decides whether to show the three-way control). A second copy
 * would be free to disagree with this one, and the disagreement would render
 * as a plausible number rather than an error.
 */
export function manualEditNeedsCause(tokenTypeCode: string): boolean {
  return !UNAMBIGUOUS_TOKEN_TYPE_CODES.has(tokenTypeCode);
}

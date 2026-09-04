/**
 * What a Flex statement failed to give us, said in the reader's words (SC-435).
 *
 * Two ways an IBKR ledger comes back short, and until now neither said
 * anything: a section the saved query never requested, and a row we received
 * and could not place. They have the same symptom — money that moved with no
 * transaction against it — and completely different fixes, one the user's and
 * one ours.
 *
 * ── Sections ──────────────────────────────────────────────────────────────
 *
 * **A Flex Query's section list is the USER'S, not ours.** We send a token and
 * a query id; which sections come back is a per-query setting ticked in IBKR's
 * UI, and a query saved without "Cash Transactions" returns a statement that
 * parses perfectly and contains no dividend, interest, deposit or withdrawal
 * ever. Every IBKR transaction we have seen in production is a `<Trade>`, and
 * the cash that plainly moved has no row at all.
 *
 * We could not tell those apart. The statement runs to hundreds of kilobytes
 * and we pulled four
 * sections out of it without once checking that four were sent, so a section
 * the query never requested and a section with nothing in it read the same:
 * as "you had no dividends this year".
 *
 * The discriminator is the CONTAINER element. `<CashTransaction>` rows sit
 * inside a `<CashTransactions>` wrapper, and the wrapper is what a selected
 * section produces — so its absence is about the query, while its presence
 * with nothing inside is about the account. That second case stays silent on
 * purpose: a user who genuinely had no dividends does not need telling, and a
 * warning they see every sync teaches the eye to skip the place the real one
 * appears.
 *
 * The wording is hedged for the same reason it is scoped to the container: it
 * reports what the statement CONTAINED, which is checkable here, rather than
 * how the query is CONFIGURED, which is not visible from this side.
 */

import type { JobNotice } from '../../core/types';

/** One section of an Activity Flex Query. */
export interface FlexSection {
  /** The container element a selected section produces. */
  readonly element: string;
  /** What the user ticks in IBKR's Flex Query editor. */
  readonly label: string;
  /** What its absence costs, in the reader's terms. */
  readonly consequence: string;
}

/** The two that feed `fetchTransactions`. */
export const TRANSACTION_SECTIONS: readonly FlexSection[] = [
  {
    element: 'Trades',
    label: 'Trades',
    consequence: 'no buys or sells could be imported',
  },
  {
    element: 'CashTransactions',
    label: 'Cash Transactions',
    consequence: 'no dividends, interest, deposits, withdrawals or fees could be imported',
  },
];

/** The two that feed `fetchBalances`. Logged, not warned on — the balance
 *  context has no warning channel, only the per-snapshot `asOfNote`. */
export const BALANCE_SECTIONS: readonly FlexSection[] = [
  { element: 'OpenPositions', label: 'Open Positions', consequence: 'no positions' },
  { element: 'CashReport', label: 'Cash Report', consequence: 'no cash balances' },
];

/**
 * Whether the statement carries a section's container element.
 *
 * The lookahead is what keeps the four names apart, and every pair is a real
 * collision: `<CashReportCurrency>` starts with `<CashReport`, `<OpenPosition>`
 * is `<OpenPositions>` minus its `s`, and `<Trade>` is `<Trades>` the same way.
 * Requiring whitespace, `>` or `/` after the name means only the wrapper
 * matches — get this wrong and a statement full of rows reports the very
 * section that holds them missing.
 */
export function hasFlexSection(xml: string, element: string): boolean {
  return new RegExp(`<${element}(?=[\\s>/])`).test(xml);
}

export function missingFlexSections(xml: string, sections: readonly FlexSection[]): FlexSection[] {
  return sections.filter((section) => !hasFlexSection(xml, section.element));
}

/**
 * One warning naming every missing section, rather than one per section.
 *
 * **Unkeyed on purpose (SC-434), and for the same reason as `PageCapWatch`.**
 * `describeStatementWindow` below is keyed because everything it interpolates
 * is an identifier — an ISO date, IBKR's own `period` name. This one
 * interpolates `FlexSection.consequence`, which is English prose written in
 * this file (`no dividends, interest, deposits, withdrawals or fees could be
 * imported`), joined into a variable-length list. `JobNotice.params` is flat
 * primitives because it crosses a jsonb column, so that list has to arrive
 * pre-joined as one string — a key would put a translated frame around
 * untranslated English, which reads worse than the English sentence it
 * replaces. Keying it means keying the sections, which is a change to the
 * section table rather than to this function.
 *
 * A reader missing two sections has one problem — a query saved with the wrong
 * boxes ticked — and should meet it once, next to the single edit that fixes
 * it. Returns null when nothing is missing, so the caller has nothing to say.
 */
export function describeMissingSections(missing: readonly FlexSection[]): string | null {
  if (missing.length === 0) return null;
  const labels = missing.map((s) => `"${s.label}"`).join(' or ');
  const consequences = missing.map((s) => s.consequence).join(', and ');
  return (
    `ibkr: this Flex statement carried no ${labels} ` +
    `${missing.length === 1 ? 'section' : 'sections'}, so ${consequences}. ` +
    `If you have had any, add ${missing.length === 1 ? 'it' : 'them'} to your Flex Query ` +
    '(IBKR Client Portal → Performance & Reports → Flex Queries → edit the query), ' +
    'save, and re-run the import.'
  );
}

/** How many distinct type strings the warning names before it summarizes. */
const TYPES_NAMED = 4;

/**
 * Cash rows that arrived and could not be placed.
 *
 * `classifyCashType` matches IBKR's `type` attribute EXACTLY, so a category we
 * never knew about — or one IBKR renames — silently takes real money out of
 * the ledger. This is the missing-section failure arriving through the other
 * door, and it gets the same voice rather than a log line: from the reader's
 * side both look like a deposit that never appeared.
 *
 * It names the types verbatim because the string is the actionable part — it
 * is what has to be added to the map, and a reader who forwards the warning
 * has forwarded the whole bug report.
 *
 * **Unkeyed (SC-434).** The types themselves are IBKR identifiers and would
 * travel fine, but `and N further types` is an English clause inside the same
 * interpolated list, and the sentence pluralises on a count in three places —
 * which in Russian is three `_one`/`_few`/`_many` stems per key, the
 * hand-written plural table `providerHorizon` avoids by wording its number
 * through `Intl` instead. Neither is unsolvable; both are more than a
 * migration.
 */
export function describeUnmappedCashTypes(counts: ReadonlyMap<string, number>): string | null {
  if (counts.size === 0) return null;
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const named = rows.slice(0, TYPES_NAMED).map(([type, n]) => `"${type}" (${n})`);
  const rest = rows.length - named.length;
  if (rest > 0) named.push(`and ${rest} further type${rest === 1 ? '' : 's'}`);
  const total = rows.reduce((sum, [, n]) => sum + n, 0);
  return (
    `ibkr: ${total} cash transaction${total === 1 ? '' : 's'} in this statement had a type ` +
    `Scani does not recognise — ${named.join(', ')} — so ${total === 1 ? 'it was' : 'they were'} ` +
    'not imported. This one is ours to fix, not yours: please report it.'
  );
}

/**
 * The order fields are named in, so two statements with the same blanks
 * produce the same key and the same sentence.
 */
const CASH_FIELD_ORDER = ['type', 'currency', 'amount'] as const;

/**
 * Cash rows that arrived carrying money with a required field blank (SC-873).
 *
 * This is the third way a Flex statement comes back short, and it was the one
 * with no voice: `describeMissingSections` speaks for a section that never
 * arrived and `describeUnmappedCashTypes` for a row whose type we could not
 * place, while a row missing its `currency` or its `amount` was dropped with
 * nothing said anywhere — not to the user, not to a log. SC-855 measured 177
 * rows a run taking the LOUD path; nothing ever counted this one, which is
 * why the true loss is larger than 177 and not knowable from the old code.
 *
 * **These rows stay dropped, deliberately.** Importing one means inventing the
 * blank — the account's base currency, or a zero amount — and a fabricated
 * ledger row is worse than an absent one: it is indistinguishable from a real
 * one the next time anybody looks, whereas an absent one is what this warning
 * now points at. A blank `type` cannot be classified at all.
 *
 * **Unkeyed (SC-434):** the list is `N with no currency or amount` — our own
 * English joining IBKR's field names — so the clause inside the interpolation
 * would stay English under a Russian frame. Same boundary as
 * `describeMissingSections` above.
 *
 * It names the FIELD rather than the row because that is what says whose fix
 * it is. The same field blank on every row is a Flex Query column that was
 * never ticked, which the user fixes in IBKR's editor; a field blank on one
 * row out of many is IBKR's own data, which is ours to handle. The two need
 * different actions, and a warning that only counted rows would send every
 * reader down the same one.
 */
export function describeIncompleteCashRows(counts: ReadonlyMap<string, number>): string | null {
  if (counts.size === 0) return null;
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = rows.reduce((sum, [, n]) => sum + n, 0);
  const named = rows.map(([fields, n]) => `${n} with no ${fields}`).join(', ');
  return (
    `ibkr: ${total} cash transaction${total === 1 ? '' : 's'} in this statement ` +
    `arrived with a required field blank — ${named} — so ` +
    `${total === 1 ? 'it was' : 'they were'} not imported. ` +
    'If your Flex Query is missing those columns, add them (IBKR Client Portal → ' +
    'Performance & Reports → Flex Queries → edit the query), save, and re-run the ' +
    'import. If the columns are there, the data came to us blank and this one is ' +
    'ours: please report it.'
  );
}

/** The blank fields of one cash row, in `CASH_FIELD_ORDER`, joined for a count key. */
export function incompleteCashFieldsKey(row: {
  type: string;
  currency: string;
  amount: string;
}): string {
  return CASH_FIELD_ORDER.filter((field) => !row[field]).join(' or ');
}

/** The window a `<FlexStatement>` says it covers. `from` is null when the
 *  statement carried no readable `fromDate`. */
export interface FlexStatementWindow {
  readonly from: Date | null;
  /** IBKR's own name for the range, e.g. `Last365CalendarDays`. Often blank. */
  readonly period: string;
}

/**
 * Why a run that asked for the whole ledger did not get one (SC-882).
 *
 * The other nine providers with a bounded look-back DECLARE it, as
 * `transactionHistoryHorizonMs`, and `TransactionRouter` reads that before
 * the call to decide whether a completeness claim is available at all. IBKR
 * cannot: it substitutes no window of its own — `requestReport` puts `t`, `q`
 * and `v=3` on the wire and no date range — so the window is whatever the
 * user's saved Flex Query names, unknown until the statement arrives and
 * different for the next user. A static declaration would be a guess about
 * somebody else's configuration, and the router would then state that guess
 * back to a reader whose query names thirty days.
 *
 * So the statement's own `fromDate` is the answer, and the channel for
 * evidence that arrives DURING a walk is `retractHistoryClaim` (SC-395).
 *
 * **A window that cannot be read still retracts.** Silence about the range is
 * not a range covering everything, and reading it as one is the same
 * optimistic default this exists to remove, one layer down.
 *
 * **It returns a `JobNotice` rather than a string, so a Russian reader meets
 * it in Russian (SC-434).** This is the only one of this file's four sentences
 * that can be keyed: the two things it interpolates are an ISO date and
 * IBKR's own `period` identifier, and neither is a word. Three keys rather
 * than one, because the branch a run takes is decided by the user's saved
 * query rather than by anything here. `text` is still the English sentence
 * and is what renders when a build does not carry the key.
 */
export function describeStatementWindow(window: FlexStatementWindow): JobNotice {
  const advice =
    'The range is a setting on your saved Flex Query and Scani does not ' +
    'choose it — to reach further back, change that query’s date range (IBKR Client Portal → ' +
    'Performance & Reports → Flex Queries → edit the query), save, and re-run the import.';
  if (window.from === null) {
    return {
      key: 'v3.jobs.notices.ibkrStatementWindowUnknown',
      text:
        'ibkr: this Flex statement does not say which window it covers, so it cannot be read ' +
        `as the account’s whole history. ${advice}`,
    };
  }
  // ISO-8601, and it stays ISO-8601 in every language. The date crosses a
  // jsonb column as a flat primitive (`JobNotice.params`), and re-parsing a
  // string back into a `Date` on the client to localise it buys a failure mode
  // on the one screen a reader opens when their import has already gone wrong.
  const from = window.from.toISOString().slice(0, 10);
  return window.period
    ? {
        key: 'v3.jobs.notices.ibkrStatementWindowPeriod',
        // `period` is IBKR's own name for the range — `Last365CalendarDays` —
        // so it is an identifier rather than a sentence.
        params: { from, period: window.period },
        text:
          `ibkr: this Flex statement covers ${from} onward (period "${window.period}"), so ` +
          `anything before that was never fetched. ${advice}`,
      }
    : {
        key: 'v3.jobs.notices.ibkrStatementWindow',
        params: { from },
        text:
          `ibkr: this Flex statement covers ${from} onward, so anything before that was never ` +
          `fetched. ${advice}`,
      };
}

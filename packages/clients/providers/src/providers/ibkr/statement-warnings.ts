import type { JobNotice, JobNoticeList } from '../../core/types';
import { englishList } from '../../core/utils/english-list';
import { namedTypeCounts } from '../../core/utils/named-type-counts';

/** One section of an Activity Flex Query. */
export interface FlexSection {
  /** The container element a selected section produces. */
  readonly element: string;
  /** What the user ticks in IBKR's Flex Query editor. */
  readonly label: string;
  /** What its absence costs, in the reader's terms. */
  readonly consequence: string;
}

/** A section whose absence is warned on, so its consequence is keyed (SC-1028). */
export interface WarnedFlexSection extends FlexSection {
  readonly consequenceKey: string;
}

/** The two that feed `fetchTransactions`. */
export const TRANSACTION_SECTIONS: readonly WarnedFlexSection[] = [
  {
    element: 'Trades',
    label: 'Trades',
    consequence: 'no buys or sells could be imported',
    consequenceKey: 'v3.jobs.notices.ibkrMissingTrades',
  },
  {
    element: 'CashTransactions',
    label: 'Cash Transactions',
    consequence: 'no dividends, interest, deposits, withdrawals or fees could be imported',
    consequenceKey: 'v3.jobs.notices.ibkrMissingCashTransactions',
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

export function missingFlexSections<S extends FlexSection>(
  xml: string,
  sections: readonly S[]
): S[] {
  return sections.filter((section) => !hasFlexSection(xml, section.element));
}

/**
 * One warning naming every missing section, rather than one per section.
 *
 * Keyed as a frame plus two lists (SC-1028): the section labels are what the
 * user ticks in IBKR's own English UI, so they travel as they are, and each
 * consequence is a keyed clause of its own. The client joins both lists in the
 * reader's language — "or" between labels, "and" between consequences.
 *
 * A reader missing two sections has one problem — a query saved with the wrong
 * boxes ticked — and should meet it once, next to the single edit that fixes
 * it. Returns null when nothing is missing, so the caller has nothing to say.
 */
export function describeMissingSections(missing: readonly WarnedFlexSection[]): JobNotice | null {
  if (missing.length === 0) return null;
  const sections: JobNoticeList = {
    type: 'disjunction',
    items: missing.map((s) => ({ key: null, text: `"${s.label}"` })),
  };
  const consequences: JobNoticeList = {
    type: 'conjunction',
    items: missing.map((s) => ({ key: s.consequenceKey, text: s.consequence })),
  };
  return {
    key: 'v3.jobs.notices.ibkrMissingSections',
    params: { count: missing.length },
    lists: { sections, consequences },
    text:
      `ibkr: this Flex statement carried no ${englishList(sections)} ` +
      `${missing.length === 1 ? 'section' : 'sections'}, so ${englishList(consequences)}. ` +
      `If you have had any, add ${missing.length === 1 ? 'it' : 'them'} to your Flex Query ` +
      '(IBKR Client Portal → Performance & Reports → Flex Queries → edit the query), ' +
      'save, and re-run the import.',
  };
}

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
 * Keyed per SC-1028: the type strings are IBKR identifiers and travel as
 * they are, and the counted remainder is a keyed item of the same list, so
 * every plural is the client's `count` rather than an English suffix.
 */
export function describeUnmappedCashTypes(counts: ReadonlyMap<string, number>): JobNotice | null {
  const named = namedTypeCounts(counts, 'v3.jobs.notices.ibkrFurtherTypes');
  if (!named) return null;
  const { types, total } = named;
  return {
    key: 'v3.jobs.notices.ibkrUnmappedCashTypes',
    params: { count: total },
    lists: { types },
    text:
      `ibkr: ${total} cash transaction${total === 1 ? '' : 's'} in this statement had a type ` +
      `Scani does not recognise — ${englishList(types)} — so ${total === 1 ? 'it was' : 'they were'} ` +
      'not imported. This one is ours to fix, not yours: please report it.',
  };
}

/**
 * The order fields are named in, so two statements with the same blanks
 * produce the same key and the same sentence.
 */
const CASH_FIELD_ORDER = ['type', 'currency', 'amount'] as const;

const FIELD_SEPARATOR = ' or ';

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
 * Keyed per SC-1028 as a list of per-field-set clauses, each carrying its
 * own list of IBKR field names, which are identifiers and travel as they are.
 *
 * It names the FIELD rather than the row because that is what says whose fix
 * it is. The same field blank on every row is a Flex Query column that was
 * never ticked, which the user fixes in IBKR's editor; a field blank on one
 * row out of many is IBKR's own data, which is ours to handle. The two need
 * different actions, and a warning that only counted rows would send every
 * reader down the same one.
 */
export function describeIncompleteCashRows(counts: ReadonlyMap<string, number>): JobNotice | null {
  if (counts.size === 0) return null;
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = rows.reduce((sum, [, n]) => sum + n, 0);
  const blanks: JobNoticeList = {
    type: 'conjunction',
    items: rows.map(([key, n]) => {
      const fields: JobNoticeList = {
        type: 'disjunction',
        items: key.split(FIELD_SEPARATOR).map((field) => ({ key: null, text: field })),
      };
      return {
        key: 'v3.jobs.notices.ibkrBlankFields',
        params: { rows: n },
        lists: { fields },
        text: `${n} with no ${englishList(fields)}`,
      };
    }),
  };
  return {
    key: 'v3.jobs.notices.ibkrIncompleteCashRows',
    params: { count: total },
    lists: { blanks },
    text:
      `ibkr: ${total} cash transaction${total === 1 ? '' : 's'} in this statement ` +
      `arrived with a required field blank — ${englishList(blanks)} — so ` +
      `${total === 1 ? 'it was' : 'they were'} not imported. ` +
      'If your Flex Query is missing those columns, add them (IBKR Client Portal → ' +
      'Performance & Reports → Flex Queries → edit the query), save, and re-run the ' +
      'import. If the columns are there, the data came to us blank and this one is ' +
      'ours: please report it.',
  };
}

/** The blank fields of one cash row, in `CASH_FIELD_ORDER`, joined for a count key. */
export function incompleteCashFieldsKey(row: {
  type: string;
  currency: string;
  amount: string;
}): string {
  return CASH_FIELD_ORDER.filter((field) => !row[field]).join(FIELD_SEPARATOR);
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

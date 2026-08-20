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
 * ever. Every one of the 159 IBKR transactions in production is a `<Trade>`,
 * and the cash that plainly moved — USD +1.90 on 2026-08-14, +300.00 on
 * 2026-08-15 — has no row at all.
 *
 * We could not tell those apart. The statement is 734 KB and we pulled four
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

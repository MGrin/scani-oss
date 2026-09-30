import type { TFunction } from 'i18next';

/** Holdings and accounts; bills and payees since SC-1408. A payee is the
 *  bills' account: a standing rule over every bill it sends, now and later. */
export type MemberKind = 'holding' | 'account' | 'bill' | 'payee';

/** The order runs of kinds appear in, and the filter offers them in. */
export const MEMBER_KINDS: readonly MemberKind[] = ['holding', 'account', 'bill', 'payee'];

export interface MemberEntry {
  id: string;
  kind: MemberKind;
  /** Zone 1 of `<DataRow>`: the token symbol, or the account's name. */
  label: string;
  /** The identity line under it: token name and institution, or the account's
   *  holding count. Never a figure — that is the value zone's job. */
  sublabel: string;
  /**
   * Set on a holding the list shows but the group's total does not count.
   *
   * The list keeps inactive positions — a closed one is still in the group and
   * still removable — while `GroupValuationService` values active holdings
   * only. Carried on the entry rather than looked up again at render time so
   * the row that is uncounted and the sentence that says how many there are
   * read the same field (SC-388).
   */
  inactive?: boolean;
  /** The row's figure, which its badge sits under (UI standard rule 5): a
   *  holding's or an account's value in base currency, a bill's amount in its
   *  own. A payee has none; it stands for bills that each carry their own. */
  figure?: { value: number | string | null; currency: string };
  account?: string;
  accountId?: string;
  /** A bill's payee: ticking the payee brings the bill (SC-1408). */
  payeeId?: string;
  available?: number;
  inherited?: boolean;
  /** How this row is in the group: its own row, an account's rule, a payee's
   *  rule, or explicitly out despite one. */
  membership?: 'direct' | 'inherited' | 'payee' | 'excluded';
}

/** Kinds in `MEMBER_KINDS` order, then alphabetical. Several kinds in one
 *  list need a stable order or a row moves under the finger when a sibling is
 *  removed. */
export function compareMembers(a: MemberEntry, b: MemberEntry): number {
  if (a.kind !== b.kind) return MEMBER_KINDS.indexOf(a.kind) - MEMBER_KINDS.indexOf(b.kind);
  return a.label.localeCompare(b.label);
}

export function memberMatches(entry: MemberEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return entry.label.toLowerCase().includes(q) || entry.sublabel.toLowerCase().includes(q);
}

/**
 * "3 holdings · 1 account" — the same sentence the list row shows, so a group's
 * page and its row in the list cannot describe the same record differently.
 *
 * The plural rule used to live in a `countLabel(count, noun)` helper here that
 * took the English noun and appended an `s` (SC-368). One place for the rule was
 * the right instinct — the groups list kept its own copy and read "1 holdings"
 * until SC-88 — but the rule it centralised was ENGLISH's, and the noun arrived
 * as a bare word no translation could reach. `en.json` is the one place now, and
 * `_one`/`_other` is a rule each language states for itself.
 */
export function memberCountLine(members: readonly MemberEntry[], t: TFunction): string {
  return memberCountsLine((kind) => countOfKind(members, kind), t);
}

/**
 * The same line from counts alone, for the groups list, which has no member
 * rows to count — so the list row and the group's own header read one rule.
 *
 * A kind is named only when present: "0 holdings · 0 accounts · 1 bill" on a
 * bills group, or "0 bills" on a portfolio one, is noise (SC-1408). An empty
 * group says so in words rather than as a row of zeros (SC-1419).
 */
export function memberCountsLine(count: (kind: MemberKind) => number, t: TFunction): string {
  const present = MEMBER_KINDS.filter((kind) => count(kind) > 0);
  if (present.length === 0) return t('v3.membership.noMembersYet');
  return present
    .map((kind) => t(`v3.membership.count.${kind}`, { count: count(kind) }))
    .join(' · ');
}

/**
 * How many members of one kind — the only arithmetic this surface does over
 * the two.
 *
 * Adding them was the defect SC-388 was reported for: a group of 36 holdings
 * and 10 accounts titled its list "In this group (46)" directly above 36 rows,
 * and 46 is a count of MEMBERS in a unit nothing else on the screen uses. Ten
 * of those accounts also bring the holdings already among the 36, so the sum
 * is not even a count of positions. Every number on that page is per kind now,
 * and there is nowhere left for the two to be added.
 */
export function countOfKind(members: readonly MemberEntry[], kind: MemberKind): number {
  return members.filter((entry) => entry.kind === kind).length;
}

/** Members the list shows and the group's total leaves out (SC-388). */
export function inactiveMemberCount(members: readonly MemberEntry[]): number {
  return members.filter((entry) => entry.kind === 'holding' && entry.inactive).length;
}

/** Everything not already a member, in the same order the member list uses. */
export function candidatesFor(
  all: readonly MemberEntry[],
  members: readonly MemberEntry[]
): MemberEntry[] {
  const taken = new Set(members.map((m) => `${m.kind}:${m.id}`));
  return all.filter((entry) => !taken.has(`${entry.kind}:${entry.id}`)).sort(compareMembers);
}

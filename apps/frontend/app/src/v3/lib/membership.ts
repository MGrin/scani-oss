/**
 * The vocabulary shared by every v3 surface that edits *who belongs to what*
 * — a group's holdings and accounts, a vault's holdings (SC-70).
 *
 * v2 modelled membership as a wizard: walk three steps, tick boxes against a
 * flat list, commit the whole set on Save. That is the shape of *creating*
 * something. Editing a group is almost always one small change — add this
 * holding, drop that account — and a wizard makes you re-answer every question
 * you did not come to change. It also cannot show the one thing an editor
 * needs: what is in the group *now*, as distinct from what is merely available.
 *
 * So the model here is two lists, not one checkbox set. `members` is the
 * record's current contents and reads first; `candidates` is everything else
 * and is only reached deliberately. A row carries its own action, and the
 * action applies immediately — there is no pending state to commit, and
 * therefore no Save button to lose off the edge of a phone.
 */

export type MemberKind = 'holding' | 'account';

export interface MemberEntry {
  id: string;
  kind: MemberKind;
  /** Zone 1 of `<DataRow>`: the token symbol, or the account's name. */
  label: string;
  /** The identity line under it: token name and institution, or the account's
   *  holding count. Never a figure — that is the value zone's job. */
  sublabel: string;
}

/** Holdings before accounts, then alphabetical. Two kinds in one list need a
 *  stable order or a row moves under the finger when a sibling is removed. */
export function compareMembers(a: MemberEntry, b: MemberEntry): number {
  if (a.kind !== b.kind) return a.kind === 'holding' ? -1 : 1;
  return a.label.localeCompare(b.label);
}

export function memberMatches(entry: MemberEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return entry.label.toLowerCase().includes(q) || entry.sublabel.toLowerCase().includes(q);
}

/**
 * "1 holding", "2 holdings", "0 holdings" — the one place the plural rule for
 * a membership count is written.
 *
 * The groups list kept its own copy of the sentence and read "1 holdings"
 * until SC-88, because the count reached it as the string `"1"` and `"1" === 1`
 * is false. The wire delivers a number now; sharing the sentence is what stops
 * a third copy from drifting again.
 */
export function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * "3 holdings · 1 account" — the same sentence the list row shows, so a group's
 * page and its row in the list cannot describe the same record differently.
 */
export function memberCountLine(members: readonly MemberEntry[]): string {
  const holdings = members.filter((m) => m.kind === 'holding').length;
  const accounts = members.filter((m) => m.kind === 'account').length;
  return [countLabel(holdings, 'holding'), countLabel(accounts, 'account')].join(' · ');
}

/** Everything not already a member, in the same order the member list uses. */
export function candidatesFor(
  all: readonly MemberEntry[],
  members: readonly MemberEntry[]
): MemberEntry[] {
  const taken = new Set(members.map((m) => `${m.kind}:${m.id}`));
  return all.filter((entry) => !taken.has(`${entry.kind}:${entry.id}`)).sort(compareMembers);
}

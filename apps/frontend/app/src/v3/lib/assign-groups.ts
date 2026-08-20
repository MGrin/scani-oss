import type { TFunction } from 'i18next';

/**
 * Putting a batch of holdings or accounts into groups, as the part of it that
 * is not a DOM.
 *
 * The save is a **diff, never a replace**, and that is the one invariant here
 * worth a test of its own. The dialog only ever shows the groups every selected
 * row already shares, so a holding that sits in a group the others do not is
 * looking at a checkbox list that does not mention it. Writing "the checked set"
 * would silently take that holding out of that group — a deletion the reader
 * never saw offered, on a screen whose whole subject is other rows.
 *
 * v2 computes the same diff inline in the component, which is why the property
 * has never been asserted anywhere.
 */

export interface GroupAssignmentDiff {
  addedGroupIds: string[];
  removedGroupIds: string[];
}

/**
 * @param preChecked the groups common to every selected row, as the query
 *   returned them — the state the reader was shown.
 * @param selected the state the reader left the list in.
 */
export function groupAssignmentDiff(
  preChecked: ReadonlySet<string>,
  selected: ReadonlySet<string>
): GroupAssignmentDiff {
  const addedGroupIds: string[] = [];
  const removedGroupIds: string[] = [];
  for (const id of selected) {
    if (!preChecked.has(id)) addedGroupIds.push(id);
  }
  for (const id of preChecked) {
    if (!selected.has(id)) removedGroupIds.push(id);
  }
  return { addedGroupIds, removedGroupIds };
}

export function isEmptyDiff(diff: GroupAssignmentDiff): boolean {
  return diff.addedGroupIds.length === 0 && diff.removedGroupIds.length === 0;
}

/**
 * What the save did, in a sentence assembled by a translator rather than by us.
 *
 * Three whole strings and no concatenation: a language that inflects the verb
 * for the count cannot be served by "Added to N groups" glued to ", removed
 * from M" (SC-235). v2 says "Groups assigned" in all three cases, including the
 * one where the only thing that happened was a removal.
 */
export function describeAssignment(diff: GroupAssignmentDiff, t: TFunction): string {
  const added = diff.addedGroupIds.length;
  const removed = diff.removedGroupIds.length;
  if (added > 0 && removed > 0) return t('v3.groups.assign.toast.changed');
  if (removed > 0) return t('v3.groups.assign.toast.removed', { count: removed });
  return t('v3.groups.assign.toast.added', { count: added });
}

/**
 * What is still missing before the empty-state "create your first group and
 * assign it" button can be pressed — §2.5's rule that a disabled button always
 * says why, which v2's version breaks by greying out over a bare `.trim()`.
 */
export function createAndAssignBlockers(name: string, t: TFunction): string[] {
  return name.trim().length === 0 ? [t('v3.groups.assign.needName')] : [];
}

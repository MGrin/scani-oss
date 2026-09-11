import type { CostBasisMethodDto } from '@scani/shared';
import { COST_BASIS_METHODS } from '@scani/shared';
import type { TFunction } from 'i18next';

/**
 * The Settings block's pure half — what the method is CALLED, and whether a
 * chosen one is a change at all (SC-980).
 *
 * Both are here rather than in the component for the reason every other v3
 * `lib/` module exists: neither needs a DOM to be wrong, and the second is the
 * only thing standing between a reader and a confirmation that offers to
 * rewrite four hundred days of history into the state it is already in.
 */

/**
 * The method in a reader's words.
 *
 * The stored values are `fifo` and `uk_section_104` — one an acronym and one a
 * statute reference — and neither is a phrase anybody would recognise as
 * describing their own tax position. The label carries both halves: the name a
 * reader may have met from an accountant, and the identifier so the two can be
 * matched up.
 *
 * Keyed per method rather than assembled, so a translator sees a whole name.
 */
export function costBasisMethodLabel(t: TFunction, method: CostBasisMethodDto): string {
  return t(`v3.settings.costBasis.method.${method}`);
}

/** Every method, in the order the contract declares them, labelled. */
export function costBasisMethodOptions(
  t: TFunction
): readonly { value: CostBasisMethodDto; label: string }[] {
  return COST_BASIS_METHODS.map((value) => ({ value, label: costBasisMethodLabel(t, value) }));
}

/**
 * The change a reader has actually asked for, or null when they have asked for
 * none.
 *
 * Null on both of the ways "no change" arrives — nothing chosen yet, and the
 * method already in force chosen again — because the two are one answer to the
 * commit button: there is nothing to confirm. The second matters more than it
 * looks: `user_cost_basis_method_changes` carries a
 * `previous_method <> new_method` CHECK, so a same-method commit is a write the
 * database refuses, and the reader would have confirmed a rewrite of their
 * history to be told it failed.
 */
export function costBasisChangeRequest(
  current: CostBasisMethodDto,
  chosen: CostBasisMethodDto | null
): CostBasisMethodDto | null {
  if (chosen === null) return null;
  return chosen === current ? null : chosen;
}

/**
 * The pure half of manual entry — what a half-filled form is still missing,
 * and what a complete one sends.
 *
 * Split out for the reason `describePaymentFormBlockers` was: v2's form
 * computes `canSubmit` from five booleans inline, so the only thing it can
 * ever tell the user is that the button is grey. Naming each missing piece is
 * the difference between a form and a guessing game, and a list of strings is
 * something a test can hold.
 *
 * The shape sent to `batchOperations.createHoldingsBatch` is v2's, unchanged:
 * the worker creates the institution, the account and the holdings in one job
 * and prices each holding afterwards, which is why this enqueues rather than
 * writing.
 */

export type PickMode = 'existing' | 'new';

export interface HoldingDraft {
  /** Stable React key. Not sent. */
  uid: string;
  tokenId: string;
  /** Display only, so a chosen token reads back before `tokens.getAll` lands. */
  tokenLabel: string;
  balance: string;
}

export interface NewInstitutionDraft {
  name: string;
  typeId: string;
  website: string;
}

export interface NewAccountDraft {
  name: string;
  typeId: string;
}

/**
 * Where a capture lands — an institution and an account under it, either
 * chosen or being created.
 *
 * Split out of `ManualEntryDraft` by V3-44, because it is the *same* question
 * the file import asks before it will take a screenshot, and asking it twice in
 * two shapes is how the two forms drifted apart in v2: one calls it
 * `AccountSelectionStep` and reports nothing, the other inlines five booleans.
 * One draft, one blocker list, one pair of fields.
 */
export interface AccountTargetDraft {
  institutionMode: PickMode;
  institutionId: string;
  newInstitution: NewInstitutionDraft;
  accountMode: PickMode;
  accountId: string;
  newAccount: NewAccountDraft;
}

export interface ManualEntryDraft extends AccountTargetDraft {
  holdings: HoldingDraft[];
}

/** The `batchOperations.ensureAccount` payload — an id when the account already
 *  exists, otherwise the records the worker has to create first. */
export interface EnsureAccountInput {
  accountId?: string;
  institution?: { name: string; typeId: string; website?: string };
  account?: { name: string; typeId: string; institutionId?: string };
}

export interface HoldingsBatchInput {
  requestId: string;
  institution?: { name: string; typeId: string; website?: string };
  accountId?: string;
  account?: { name: string; typeId: string; institutionId?: string };
  newHoldings: { tokenId: string; balance: string }[];
  updateHoldings: never[];
}

export function emptyHolding(uid: string): HoldingDraft {
  return { uid, tokenId: '', tokenLabel: '', balance: '' };
}

export function emptyAccountTarget(): AccountTargetDraft {
  return {
    institutionMode: 'existing',
    institutionId: '',
    newInstitution: { name: '', typeId: '', website: '' },
    accountMode: 'existing',
    accountId: '',
    newAccount: { name: '', typeId: '' },
  };
}

export function emptyDraft(uid: string): ManualEntryDraft {
  return { ...emptyAccountTarget(), holdings: [emptyHolding(uid)] };
}

/**
 * `revolut.com` → `https://revolut.com`. Returns undefined for an empty field,
 * which is what the DTO wants for "no website" — an empty string would be
 * stored as one and then rendered as a broken favicon.
 */
export function normalizeWebsite(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** A row counts once it names both a token and an amount. A half-filled row is
 *  not an error — it is the row the user is still typing — so it is dropped
 *  rather than reported. */
export function completedHoldings(holdings: readonly HoldingDraft[]): HoldingDraft[] {
  return holdings.filter((holding) => holding.tokenId && holding.balance.trim());
}

/**
 * What the "where" half is still missing, in the order the form asks for it,
 * phrased as the thing to do. Empty means the target resolves.
 */
export function describeAccountTargetBlockers(draft: AccountTargetDraft): string[] {
  const blockers: string[] = [];

  if (draft.institutionMode === 'existing') {
    if (!draft.institutionId) blockers.push('choose where the account is held');
  } else {
    if (!draft.newInstitution.name.trim()) blockers.push('name the new institution');
    if (!draft.newInstitution.typeId) blockers.push("choose the institution's type");
  }

  if (draft.accountMode === 'existing') {
    if (!draft.accountId) blockers.push('choose an account');
  } else {
    if (!draft.newAccount.name.trim()) blockers.push('name the new account');
    if (!draft.newAccount.typeId) blockers.push("choose the account's type");
  }

  return blockers;
}

/**
 * What is still missing, in the order the form asks for it, phrased as the
 * thing to do. Empty means submittable.
 */
export function describeManualEntryBlockers(draft: ManualEntryDraft): string[] {
  const blockers = describeAccountTargetBlockers(draft);

  if (completedHoldings(draft.holdings).length === 0) {
    blockers.push('add a holding with both a token and an amount');
  }

  return blockers;
}

/**
 * The account the capture should land in, resolved as far as the client can.
 *
 * An **existing** account is already an id, so the caller skips the round trip
 * entirely — which matters, because `ensureAccount` is called on every submit
 * and a redundant one on a retry is a wasted write. A **new** one carries the
 * same two asymmetries `buildHoldingsBatchInput` documents: the institution is
 * sent only when it too is being created, and the account carries an
 * institution id only when the institution already exists.
 */
export function buildEnsureAccountInput(draft: AccountTargetDraft): EnsureAccountInput | null {
  if (describeAccountTargetBlockers(draft).length > 0) return null;

  if (draft.accountMode === 'existing') return { accountId: draft.accountId };

  const creatingInstitution = draft.institutionMode === 'new';
  return {
    institution: creatingInstitution
      ? {
          name: draft.newInstitution.name.trim(),
          typeId: draft.newInstitution.typeId,
          website: normalizeWebsite(draft.newInstitution.website),
        }
      : undefined,
    account: {
      name: draft.newAccount.name.trim(),
      typeId: draft.newAccount.typeId,
      institutionId: creatingInstitution ? undefined : draft.institutionId,
    },
  };
}

/**
 * The mutation payload, or null when the draft is not complete.
 *
 * Two asymmetries worth knowing, both v2's and both correct:
 *
 * - A **new account** sends no `accountId`, and carries the institution id
 *   only when the institution is an existing one. When both are new the worker
 *   creates the institution first and binds the account to it, so sending an
 *   id here would be sending one that does not exist yet.
 * - `updateHoldings` is always empty. This form only ever adds; changing a
 *   balance is the holding's own surface.
 */
export function buildHoldingsBatchInput(
  draft: ManualEntryDraft,
  requestId: string
): HoldingsBatchInput | null {
  if (describeManualEntryBlockers(draft).length > 0) return null;

  const creatingInstitution = draft.institutionMode === 'new';
  const creatingAccount = draft.accountMode === 'new';

  return {
    requestId,
    institution: creatingInstitution
      ? {
          name: draft.newInstitution.name.trim(),
          typeId: draft.newInstitution.typeId,
          website: normalizeWebsite(draft.newInstitution.website),
        }
      : undefined,
    accountId: creatingAccount ? undefined : draft.accountId,
    account: creatingAccount
      ? {
          name: draft.newAccount.name.trim(),
          typeId: draft.newAccount.typeId,
          institutionId: creatingInstitution ? undefined : draft.institutionId,
        }
      : undefined,
    newHoldings: completedHoldings(draft.holdings).map((holding) => ({
      tokenId: holding.tokenId,
      balance: holding.balance.trim(),
    })),
    updateHoldings: [],
  };
}

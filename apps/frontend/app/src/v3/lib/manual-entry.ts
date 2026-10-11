import {
  collidingHoldingTokens,
  contestedHoldingTokens,
  Decimal,
  holdingPositionKey,
} from '@scani/shared';
import { httpStatus } from '@scani/ui/lib/user-facing-error';
import { describeQueryError } from '@scani/ui/v3/lib/errors';
import type { TFunction } from 'i18next';
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
  /** The bare symbol, for copy that names the row. Falls back to `tokenLabel`. */
  tokenSymbol?: string;
  balance: string;
  /** The amount field holds text it refused to read — an exponent, or more
   *  digits than any balance has — so `balance` is empty for a reason rather
   *  than because the row is still being typed (SC-1527). */
  balanceRejected?: boolean;
  /**
   * What the user calls this pot. Asked for only when the form names one token
   * on more than one row — four RUB rows off one Tinkoff screen are four real
   * products, and before SC-330 the only way to say so was not to (the form
   * refused, and the user deleted three of their positions).
   */
  label: string;
}

export interface NewInstitutionDraft {
  name: string;
  typeId: string;
  website: string;
}

export interface NewAccountDraft {
  name: string;
  typeId: string;
  /** SC-1645: a wrapper code, sent only when one is chosen. */
  wrapper?: string | null;
}

/**
 * The account type a new account most likely has, from the kind of institution
 * holding it (SC-1327). An exchange asking "what type of account is this?" is a
 * question with one answer, so it is answered for the reader. A bank is left
 * unanswered, because checking and savings are both likely.
 */
export function defaultAccountTypeCode(institutionTypeCode: string | undefined): string | null {
  switch (institutionTypeCode) {
    case 'crypto_exchange':
    case 'crypto_wallet':
      return 'crypto';
    case 'broker':
    case 'investment_fund':
      return 'investment';
    default:
      return null;
  }
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

/** A position the chosen account already holds by hand — the `held` half of
 *  `collidingHoldingTokens`, as `batchOperations.heldPositions` returns it. */
export interface HeldPosition {
  tokenId: string;
  label?: string | null;
}

export interface ManualEntryDraft extends AccountTargetDraft {
  holdings: HoldingDraft[];
  /**
   * What the chosen EXISTING account already holds for the tokens on the form
   * (SC-1527). Without it the form could only see repeats within itself, while
   * the worker refuses a repeat of a held position too — and refused the whole
   * batch, valid rows included, after the form had said Save was fine.
   * Ignored for a new account, which holds nothing.
   */
  held?: { accountName: string; positions: readonly HeldPosition[] };
  /**
   * The chosen account is a loan or card, so each amount is what is owed:
   * typed positive, sent negative (SC-1640).
   */
  owes?: boolean;
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
  newHoldings: { tokenId: string; balance: string; label?: string }[];
  updateHoldings: never[];
}

export function emptyHolding(uid: string): HoldingDraft {
  return { uid, tokenId: '', tokenLabel: '', balance: '', label: '' };
}

/**
 * The draft after an existing institution is chosen.
 *
 * A **chosen** account is cleared: it belongs to whichever institution it was
 * under, and keeping it would submit it somewhere else entirely. A **new**
 * account being typed in stays — it has no institution yet to disagree with,
 * and the worker binds it to the one chosen here. Clearing it too threw away
 * the account a newcomer had just named, with nothing but a disabled Save
 * button to say so (SC-1250).
 */
export function withInstitution(
  draft: AccountTargetDraft,
  institutionId: string
): AccountTargetDraft {
  if (draft.accountMode === 'new') return { ...draft, institutionId };
  return { ...draft, institutionId, accountId: '', accountMode: 'existing' };
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
/**
 * The blockers as KEYS. Split from the sentence because the `build*` functions
 * below ask the same question for a different reason — is this draft complete
 * enough to send — and threading a translator into a pure input builder to get
 * a `.length` would make copy a dependency of data.
 */
function accountTargetBlockerKeys(draft: AccountTargetDraft): string[] {
  const blockers: string[] = [];

  if (draft.institutionMode === 'existing') {
    if (!draft.institutionId) blockers.push('v3.capture.blocker.chooseInstitution');
  } else {
    if (!draft.newInstitution.name.trim()) blockers.push('v3.capture.blocker.nameInstitution');
    if (!draft.newInstitution.typeId) blockers.push('v3.capture.blocker.institutionType');
  }

  if (draft.accountMode === 'existing') {
    if (!draft.accountId) blockers.push('v3.capture.blocker.chooseAccount');
  } else {
    if (!draft.newAccount.name.trim()) blockers.push('v3.capture.blocker.nameAccount');
    if (!draft.newAccount.typeId) blockers.push('v3.capture.blocker.accountType');
  }

  return blockers;
}

export function describeAccountTargetBlockers(t: TFunction, draft: AccountTargetDraft): string[] {
  return accountTargetBlockerKeys(draft).map((key) => t(key));
}

/**
 * Tokens whose rows must say which pot they are: named on more than one row,
 * or already held by the account (SC-1527) — the second is where the name
 * field used to be missing while the refusal told the user to fill it in.
 */
export function contestedHoldingTokenIds(
  holdings: readonly HoldingDraft[],
  held: readonly HeldPosition[] = []
): Set<string> {
  return contestedHoldingTokens(completedHoldings(holdings), held);
}

function heldPositions(draft: ManualEntryDraft): readonly HeldPosition[] {
  return draft.accountMode === 'existing' ? (draft.held?.positions ?? []) : [];
}

/** Rows whose position key the account already holds — what the worker
 *  refuses with `DuplicateHoldingTokenError`. */
function alreadyHeldTokenIds(draft: ManualEntryDraft): Set<string> {
  const taken = new Set(
    heldPositions(draft).map((row) => holdingPositionKey(row.tokenId, row.label))
  );
  return new Set(
    completedHoldings(draft.holdings)
      .filter((row) => taken.has(holdingPositionKey(row.tokenId, row.label)))
      .map((row) => row.tokenId)
  );
}

export function holdingSymbol(holding: HoldingDraft): string {
  return holding.tokenSymbol || holding.tokenLabel;
}

/**
 * Tokens still named twice under the SAME name — the unresolved half, and the
 * only one that blocks submit. Shares its rule with the server, so the form
 * and the guard cannot disagree about what a duplicate is.
 */
export function repeatedHoldingTokenIds(holdings: readonly HoldingDraft[]): string[] {
  return [...collidingHoldingTokens(completedHoldings(holdings))];
}

interface Blocker {
  key: string;
  vars?: Record<string, string>;
}

function isZeroAmount(balance: string): boolean {
  try {
    return new Decimal(balance.trim()).isZero();
  } catch {
    return false;
  }
}

function symbolsOf(rows: readonly HoldingDraft[]): string {
  return [...new Set(rows.map(holdingSymbol))].join(', ');
}

/**
 * What is still missing, in the order the form asks for it, phrased as the
 * thing to do. Empty means submittable.
 */
function manualEntryBlockers(draft: ManualEntryDraft): Blocker[] {
  const blockers: Blocker[] = accountTargetBlockerKeys(draft).map((key) => ({ key }));
  const completed = completedHoldings(draft.holdings);
  // A row the amount field refused is not "still being typed": it was typed,
  // and nothing reached the value. Dropping it as unfinished is how a row
  // vanished from the save with Save enabled.
  const unreadable = draft.holdings.filter((row) => row.tokenId && row.balanceRejected);
  if (completed.length === 0 && unreadable.length === 0) {
    blockers.push({ key: 'v3.capture.blocker.addHolding' });
  }
  if (unreadable.length > 0) {
    blockers.push({
      key: 'v3.capture.blocker.unreadableAmount',
      vars: { tokens: symbolsOf(unreadable) },
    });
  }
  // A new holding of nothing writes a row that only ever reads zero, and is
  // almost always a field left at its placeholder.
  const zero = completed.filter((row) => isZeroAmount(row.balance));
  if (zero.length > 0) {
    blockers.push({ key: 'v3.capture.blocker.zeroAmount', vars: { tokens: symbolsOf(zero) } });
  }
  if (repeatedHoldingTokenIds(draft.holdings).length > 0) {
    blockers.push({ key: 'v3.capture.blocker.duplicateToken' });
  }
  const held = alreadyHeldTokenIds(draft);
  if (held.size > 0 && draft.held) {
    blockers.push({
      key: 'v3.capture.blocker.alreadyHeld',
      vars: {
        account: draft.held.accountName,
        tokens: symbolsOf(completed.filter((row) => held.has(row.tokenId))),
      },
    });
  }
  return blockers;
}

export function describeManualEntryBlockers(t: TFunction, draft: ManualEntryDraft): string[] {
  return manualEntryBlockers(draft).map(({ key, vars }) => t(key, vars));
}

/**
 * The sentence for a save the server refused.
 *
 * A 409 is `createHoldingsBatch` finding a held position the form did not know
 * about — one added in another tab since the form loaded (SC-1527). It is
 * refused before anything is enqueued, so nothing was written and the rows are
 * still on the form; the caller refetches what the account holds, and the
 * rows it names are marked. Anything else is `describeQueryError`'s.
 */
export function describeManualEntryFailure(t: TFunction, error: unknown): string {
  if (httpStatus(error) === 409) return t('v3.capture.page.manual.alreadyHeldError');
  const copy = describeQueryError(error, t('v3.capture.page.manual.subject'), 'create');
  return `${copy.title}. ${copy.detail}`;
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
  if (accountTargetBlockerKeys(draft).length > 0) return null;

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
      ...(draft.newAccount.wrapper ? { wrapper: draft.newAccount.wrapper } : {}),
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
/** A typed owed amount as the balance stored: negative, and zero stays zero. */
function owedBalance(balance: string, owes: boolean | undefined): string {
  return owes && !/^0*\.?0*$/.test(balance) ? `-${balance}` : balance;
}

/**
 * Whether the account a manual entry targets is a loan or card (SC-1640), by
 * the type of the existing account or the type picked for a new one.
 */
export function targetOwes(
  draft: AccountTargetDraft,
  accounts: readonly { id: string; typeId: string }[] | undefined,
  accountTypes: readonly { id: string; class: string }[] | undefined
): boolean {
  const typeId =
    draft.accountMode === 'new'
      ? draft.newAccount.typeId
      : accounts?.find((account) => account.id === draft.accountId)?.typeId;
  return accountTypes?.find((row) => row.id === typeId)?.class === 'liability';
}

export function buildHoldingsBatchInput(
  draft: ManualEntryDraft,
  requestId: string
): HoldingsBatchInput | null {
  if (manualEntryBlockers(draft).length > 0) return null;

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
          ...(draft.newAccount.wrapper ? { wrapper: draft.newAccount.wrapper } : {}),
        }
      : undefined,
    newHoldings: completedHoldings(draft.holdings).map((holding) => ({
      tokenId: holding.tokenId,
      // Only sent when the form actually asked. A name left on a row whose
      // token stopped repeating is not one the user chose to keep.
      label: contestedHoldingTokenIds(draft.holdings, heldPositions(draft)).has(holding.tokenId)
        ? holding.label.trim() || undefined
        : undefined,
      balance: owedBalance(holding.balance.trim(), draft.owes),
    })),
    updateHoldings: [],
  };
}

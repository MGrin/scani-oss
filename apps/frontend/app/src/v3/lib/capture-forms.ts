import type { TFunction } from 'i18next';
import { type AccountTargetDraft, describeAccountTargetBlockers } from './manual-entry';

/**
 * The pure half of the four capture forms V3-44 ports off v2 — the file import,
 * the invoice upload, the wallet address and the exchange connection.
 *
 * They are one module because they are one decision repeated four times: *what
 * is this form still missing, and what is it doing right now*. v2 answers the
 * first question with a grey button in all four files and the second with a
 * spinner in three of them, so the person watching a 40MB PDF upload over a
 * train connection is told exactly as much as the person who mistyped an API
 * key. Naming the blockers and naming the stage are both things a string can
 * carry and a test can hold, which is why they live here rather than inside a
 * component.
 *
 * The file classification is v2's, deliberately unchanged: which parser reads a
 * given extension is a contract with the worker, not presentation this port is
 * entitled to renegotiate.
 */

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const;
const STATEMENT_EXTENSIONS = ['csv', 'tsv', 'ofx', 'qfx', 'qif'] as const;

/** Everything `/v3/import` takes, in the order the accept attribute lists it. */
const IMPORT_EXTENSIONS: readonly string[] = [...IMAGE_EXTENSIONS, 'pdf', ...STATEMENT_EXTENSIONS];

export const IMPORT_ACCEPT = IMPORT_EXTENSIONS.map((ext) => `.${ext}`).join(',');

/** The same set said to a person rather than to a file dialog. */
export const IMPORT_FORMATS_KEY = 'v3.capture.formats.import';

/**
 * `pdf` is deliberately on the screenshot path: the parse job reads a rendered
 * page, and a bank's PDF statement is a picture of a table as far as extraction
 * is concerned.
 */
export interface ImportFilePlan {
  /** `storage.getUploadUrl`'s `purpose`. */
  purpose: 'screenshot' | 'file-import';
  contentType: string;
  /** Which of the three statement parsers reads it. Absent for a screenshot. */
  format?: 'csv' | 'ofx' | 'qif';
}

function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

/** Null for an extension neither parser reads. */
export function planImportFile(file: { name: string; type?: string }): ImportFilePlan | null {
  const ext = fileExtension(file.name);

  if ((IMAGE_EXTENSIONS as readonly string[]).includes(ext)) {
    // The browser's own type wins where it has one: a `.jpg` that is really a
    // PNG uploads under the type R2's presigner signed for either way.
    return { purpose: 'screenshot', contentType: file.type || 'image/png' };
  }
  if (ext === 'pdf') return { purpose: 'screenshot', contentType: 'application/pdf' };
  if (!(STATEMENT_EXTENSIONS as readonly string[]).includes(ext)) return null;

  return {
    purpose: 'file-import',
    contentType: file.type || 'text/plain',
    // v2's mapping, kept byte for byte — including `.qfx` reading as CSV.
    // Which parser sees a file is the worker's contract, and a port is not the
    // place to change it.
    format: ext === 'ofx' ? 'ofx' : ext === 'qif' ? 'qif' : 'csv',
  };
}

/**
 * Invoices go to `documents.enqueueParse`, which signs the content type it was
 * given rather than trusting the browser — so this is a fixed table and an
 * unknown extension is a rejection rather than a guess.
 */
const INVOICE_MIME_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
};

export const INVOICE_ACCEPT = Object.keys(INVOICE_MIME_TYPES)
  .map((ext) => `.${ext}`)
  .join(',');

export const INVOICE_FORMATS_KEY = 'v3.capture.formats.invoice';

export function planInvoiceFile(file: { name: string }): { contentType: string } | null {
  const contentType = INVOICE_MIME_TYPES[fileExtension(file.name)];
  return contentType ? { contentType } : null;
}

/**
 * Why this file cannot be uploaded, or null. Said at the moment of choosing
 * rather than at submit: a file the form will not take is not a blocker to list
 * under the button, it is a choice to undo.
 */
export function describeImportFileProblem(t: TFunction, filename: string): string | null {
  if (planImportFile({ name: filename })) return null;
  return unsupportedFileMessage(t, filename, t(IMPORT_FORMATS_KEY));
}

export function describeInvoiceFileProblem(t: TFunction, filename: string): string | null {
  if (planInvoiceFile({ name: filename })) return null;
  return unsupportedFileMessage(t, filename, t(INVOICE_FORMATS_KEY));
}

function unsupportedFileMessage(t: TFunction, filename: string, formats: string): string {
  const ext = fileExtension(filename);
  const named = ext ? t('v3.capture.file.extension', { ext }) : t('v3.capture.file.noExtension');
  return t('v3.capture.file.unsupported', { named, formats });
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB'] as const;

/** "846 KB", "12.4 MB". A file's size is the one thing that tells a person
 *  whether a slow upload is the connection or the file. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 || value >= 10 ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded} ${SIZE_UNITS[unit]}`;
}

/**
 * Which step of a submission is running.
 *
 * Every one of these forms is three or four network calls deep — resolve the
 * account, sign the upload, send the bytes, enqueue the parse — and v2 renders
 * one spinner over the whole sequence. Naming the step is what makes a 30-second
 * wait legible: "sending the file" over a slow connection is normal, and the
 * same 30 seconds spent on "starting the parse" is not.
 */
export type CaptureStage = 'account' | 'upload' | 'parse' | 'enqueue' | 'connect';

const STAGE_KEYS: Record<CaptureStage, string> = {
  account: 'v3.capture.stage.account',
  upload: 'v3.capture.stage.upload',
  parse: 'v3.capture.stage.parse',
  enqueue: 'v3.capture.stage.enqueue',
  connect: 'v3.capture.stage.connect',
};

export function describeCaptureStage(t: TFunction, stage: CaptureStage): string {
  return t(STAGE_KEYS[stage]);
}

/** What the file import is still missing. The "where" half is manual entry's,
 *  unchanged — the two forms ask the same question and now say the same thing
 *  about it. */
export function describeImportBlockers(
  t: TFunction,
  target: AccountTargetDraft,
  file: { name: string } | null
): string[] {
  const blockers = describeAccountTargetBlockers(t, target);
  if (!file) blockers.push(t('v3.capture.blocker.chooseFile'));
  return blockers;
}

export function describeInvoiceBlockers(t: TFunction, file: { name: string } | null): string[] {
  return file ? [] : [t('v3.capture.blocker.chooseInvoice')];
}

export interface WalletImportDraft {
  address: string;
  displayName: string;
}

export function emptyWalletImportDraft(): WalletImportDraft {
  return { address: '', displayName: '' };
}

/**
 * The address shapes Scani can actually read, one entry per address validator
 * in `packages/clients/providers`.
 *
 * These regexes are copies of the providers' own `isValidAddress`, and that is
 * a deliberate coupling rather than the client guessing at what a real address
 * is: `WalletDiscoveryService.detectWalletChains` asks every validator in turn
 * and an address none of them accepts is detected on no chain at all, so the
 * import job it starts can only ever fail. It used to fail *later*, on `/jobs`,
 * behind a queued row labelled `auto · not-an…ress` (D-2). Rejecting it here is
 * the same answer delivered where the fix is one keystroke.
 *
 * **Adding a chain means adding it here too.** A validator this table does not
 * mirror is a chain the form will refuse addresses for.
 *
 * `claim` is the prefix only that chain uses. It exists so a near-miss can be
 * named — "that is not a finished Ethereum address" beats "that is not an
 * address" when the field starts `0x`. Only unambiguous prefixes carry one:
 * a Bitcoin `1…` and a Solana address are both bare base58 and neither can
 * claim the other's typo.
 */
interface WalletAddressShape {
  /** How the chain is named in a sentence. */
  chain: string;
  valid: RegExp;
  claim?: RegExp;
  /** What a valid one looks like, said to a person. */
  looksLikeKey: string;
}

const WALLET_ADDRESS_SHAPES: readonly WalletAddressShape[] = [
  {
    chain: 'Ethereum',
    valid: /^0x[a-fA-F0-9]{40}$/,
    claim: /^0x/i,
    looksLikeKey: 'v3.capture.wallet.shape.ethereum',
  },
  {
    chain: 'Bitcoin',
    valid: /^(?:[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-z0-9]{39,59})$/,
    claim: /^bc1/i,
    looksLikeKey: 'v3.capture.wallet.shape.bitcoin',
  },
  {
    chain: 'TON',
    valid: /^(?:[EUk0]Q[A-Za-z0-9_-]{46}|-?[0-9]:[a-fA-F0-9]{64})$/,
    claim: /^[EUk0]Q/,
    looksLikeKey: 'v3.capture.wallet.shape.ton',
  },
  {
    chain: 'Tron',
    valid: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
    looksLikeKey: 'v3.capture.wallet.shape.tron',
  },
  {
    chain: 'Solana',
    valid: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
    looksLikeKey: 'v3.capture.wallet.shape.solana',
  },
];

/** Every shape at once, for the case where nothing was even aimed at. */
const EVERY_ADDRESS_SHAPE_KEY = 'v3.capture.wallet.everyShape';

type WalletAddressVerdict =
  | { status: 'empty' }
  | { status: 'valid' }
  /** Aimed at a chain we know, but not a complete address on it. */
  | { status: 'incomplete'; problem: string }
  | { status: 'unrecognised'; problem: string };

/** The status alone, with no sentence attached — what the builders ask for. */
function walletAddressStatus(address: string): WalletAddressVerdict['status'] {
  const value = address.trim();
  if (!value) return 'empty';
  if (WALLET_ADDRESS_SHAPES.some((shape) => shape.valid.test(value))) return 'valid';
  return WALLET_ADDRESS_SHAPES.some((shape) => shape.claim?.test(value))
    ? 'incomplete'
    : 'unrecognised';
}

function classifyWalletAddress(t: TFunction, address: string): WalletAddressVerdict {
  const value = address.trim();
  if (!value) return { status: 'empty' };
  if (WALLET_ADDRESS_SHAPES.some((shape) => shape.valid.test(value))) return { status: 'valid' };

  const claimed = WALLET_ADDRESS_SHAPES.find((shape) => shape.claim?.test(value));
  if (claimed) {
    return {
      status: 'incomplete',
      // `count` first, deliberately: `i18n-keys.test.ts` reads three lines
      // past a wrapped `t()` looking for it, and that bound is what stops it
      // finding a NEIGHBOURING call's count. Four arguments would fall outside.
      problem: t('v3.capture.wallet.incomplete', {
        count: value.length,
        chain: claimed.chain,
        shape: t(claimed.looksLikeKey),
      }),
    };
  }
  return {
    status: 'unrecognised',
    problem: t('v3.capture.wallet.unrecognised', { shapes: t(EVERY_ADDRESS_SHAPE_KEY) }),
  };
}

/**
 * Why this address cannot be watched, or null. Said at the field, for the
 * reason `describeImportFileProblem` is: what is wrong with a value the user
 * typed is a correction to make in place, not an item on a list under a button.
 */
export function describeWalletAddressProblem(t: TFunction, address: string): string | null {
  const verdict = classifyWalletAddress(t, address);
  return verdict.status === 'incomplete' || verdict.status === 'unrecognised'
    ? verdict.problem
    : null;
}

/** The short version, under the button. The field carries the detail. */
function walletImportBlockerKeys(draft: WalletImportDraft): string[] {
  switch (walletAddressStatus(draft.address)) {
    case 'empty':
      return ['v3.capture.blocker.walletEmpty'];
    case 'incomplete':
      return ['v3.capture.blocker.walletIncomplete'];
    case 'unrecognised':
      return ['v3.capture.blocker.walletUnrecognised'];
    default:
      return [];
  }
}

export function describeWalletImportBlockers(t: TFunction, draft: WalletImportDraft): string[] {
  return walletImportBlockerKeys(draft).map((key) => t(key));
}

export interface WalletImportInput {
  address: string;
  displayName?: string;
  chain: 'auto';
  requestId: string;
}

export function buildWalletImportInput(
  draft: WalletImportDraft,
  requestId: string
): WalletImportInput | null {
  if (walletImportBlockerKeys(draft).length > 0) return null;
  return {
    address: draft.address.trim(),
    displayName: draft.displayName.trim() || undefined,
    chain: 'auto',
    requestId,
  };
}

/** The half of a provider manifest's `credentialFields` this module reasons
 *  about. The form renders the rest. */
export interface CredentialFieldLike {
  name: string;
  label: string;
  required: boolean;
}

export function describeCredentialBlockers(
  fields: readonly CredentialFieldLike[],
  values: Record<string, string>,
  t: TFunction
): string[] {
  return fields
    .filter((field) => field.required && !(values[field.name] ?? '').trim())
    .map((field) => t('v3.capture.form.enterField', { label: field.label }));
}

/**
 * Only the fields the manifest declares, and only the ones with a value —
 * v2's shape. An empty optional field must be absent rather than an empty
 * string, or the validator stores a credential the provider will reject.
 */
export function buildCredentials(
  fields: readonly CredentialFieldLike[],
  values: Record<string, string>
): Record<string, string> {
  const credentials: Record<string, string> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (value !== undefined && value.length > 0) credentials[field.name] = value;
  }
  return credentials;
}

/**
 * What kind of place a provider is, by its institution type code.
 *
 * v2 lists four category groups and renders only providers whose type code
 * matches one of them, which means a provider seeded with any other type is
 * silently absent from the only screen that can connect it. Every code resolves
 * here, and an unrecognised one resolves to "Other" — visible and connectable,
 * which is the whole point of the screen.
 */
const CATEGORY_LABEL_KEYS: Record<string, string> = {
  crypto_exchange: 'v3.capture.category.cryptoExchange',
  crypto_wallet: 'v3.capture.category.cryptoWallet',
  bank: 'v3.capture.category.bank',
  broker: 'v3.capture.category.broker',
};

const INTEGRATION_CATEGORY_FALLBACK_KEY = 'v3.capture.category.other';

export function integrationCategoryLabel(
  t: TFunction,
  typeCode: string | null | undefined
): string {
  return t((typeCode && CATEGORY_LABEL_KEYS[typeCode]) || INTEGRATION_CATEGORY_FALLBACK_KEY);
}

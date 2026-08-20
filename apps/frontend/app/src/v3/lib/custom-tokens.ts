import type { TFunction } from 'i18next';

/**
 * The two custom-token forms, as the part of them that is not a DOM.
 *
 * Both ask the same three questions — a price, the currency it is quoted in,
 * and why — and v2 answers "may this be submitted?" for each with a boolean
 * expression inline in the JSX. A boolean is the wrong return type for that
 * question: it can disable a button but it cannot say why, which is how v2
 * ships two forms that refuse to proceed and explain nothing.
 *
 * So the predicate returns the missing things rather than their absence, and
 * `FormActions` renders them. Same rule the capture forms adopted (§2.5), and
 * the reason it lives here is that a list of sentences is testable and a
 * disabled attribute in a portal is not — Radix renders nothing at all under
 * `renderToStaticMarkup`.
 */

export const CUSTOM_TOKEN_TYPES = [
  { code: 'private-company', labelKey: 'v3.tokens.create.typePrivateCompany' },
  { code: 'other', labelKey: 'v3.tokens.create.typeOther' },
] as const;

export type CustomTokenTypeCode = (typeof CUSTOM_TOKEN_TYPES)[number]['code'];

/**
 * The canonical `AmountInput` string as a number the API will accept, or null.
 *
 * `Number('')` is 0 and `Number(' ')` is 0, so a plain cast reports an empty
 * field as a price of zero — which the router then rejects with a 400 that
 * says nothing the form could not have said first.
 */
export function parsePositivePrice(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Just enough of a fiat currency to map between what the picker stores (an id)
 *  and what the API takes (`baseCurrencyCode`, a symbol). */
export interface FiatCurrencyRef {
  id: string;
  symbol: string;
}

/**
 * The picker deals in token ids; `tokens.createCustom` and
 * `tokens.updateCustomPrice` both take a *symbol*. Everything that crosses that
 * boundary goes through these two, so neither form has to remember which side
 * of it a given string is on — a mix-up there is a price silently recorded
 * against the wrong currency, which no error surfaces at all.
 */
export function currencyIdForSymbol(
  currencies: readonly FiatCurrencyRef[],
  symbol: string | null | undefined
): string {
  if (!symbol) return '';
  const wanted = symbol.trim().toUpperCase();
  return currencies.find((currency) => currency.symbol.toUpperCase() === wanted)?.id ?? '';
}

export function currencySymbolForId(
  currencies: readonly FiatCurrencyRef[],
  id: string
): string | null {
  return currencies.find((currency) => currency.id === id)?.symbol ?? null;
}

export interface CustomTokenDraft {
  symbol: string;
  name: string;
  price: string;
  currencyId: string;
}

/** Ordered top-to-bottom as the fields are, so the sentence reads as a path
 *  down the form rather than a set. */
export function createCustomTokenBlockers(t: TFunction, draft: CustomTokenDraft): string[] {
  const blockers: string[] = [];
  if (draft.symbol.trim() === '') blockers.push(t('v3.tokens.create.needSymbol'));
  if (draft.name.trim() === '') blockers.push(t('v3.tokens.create.needName'));
  blockers.push(...priceBlockers(t, draft));
  return blockers;
}

export function priceBlockers(
  t: TFunction,
  draft: Pick<CustomTokenDraft, 'price' | 'currencyId'>
): string[] {
  const blockers: string[] = [];
  if (parsePositivePrice(draft.price) === null) blockers.push(t('v3.tokens.price.needPrice'));
  if (draft.currencyId === '') blockers.push(t('v3.tokens.price.needCurrency'));
  return blockers;
}

/**
 * `tokens.createCustom` maps "already exists" to a CONFLICT, and that is the
 * one failure this form has that the reader can act on — every other branch of
 * `describeQueryError` is about the request, not the symbol.
 *
 * 409 rather than the message text: the server's sentence is English forever
 * and reads "Token with symbol ACME already exists", which is a sentence about
 * a row. The reader needs a sentence about what to do next.
 */
export function isSymbolTakenError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const status = (error as { data?: { httpStatus?: unknown } | null }).data?.httpStatus;
  return status === 409;
}

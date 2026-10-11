import type { TFunction } from 'i18next';

const MONEY_IN = 'v3.holdings.activity.kind.moneyIn';
const MONEY_OUT = 'v3.holdings.activity.kind.moneyOut';

/**
 * The ledger's `kind` column, in words (SC-1527).
 *
 * Several kinds share a label: a swap's two legs are one swap to the reader,
 * and a trade's cash side is a settlement whichever way it moved. The sign of
 * the quantity beside the label already says which way.
 */
const KIND_KEYS: Readonly<Record<string, string>> = {
  deposit: MONEY_IN,
  withdraw: MONEY_OUT,
  transfer_in: 'v3.holdings.activity.kind.transferIn',
  transfer_out: 'v3.holdings.activity.kind.transferOut',
  buy: 'v3.holdings.activity.kind.bought',
  sell: 'v3.holdings.activity.kind.sold',
  swap_in: 'v3.holdings.activity.kind.swap',
  swap_out: 'v3.holdings.activity.kind.swap',
  settle_in: 'v3.holdings.activity.kind.settlement',
  settle_out: 'v3.holdings.activity.kind.settlement',
  fee: 'v3.holdings.activity.kind.fee',
  reward: 'v3.holdings.activity.kind.reward',
  interest: 'v3.holdings.activity.kind.interest',
  airdrop: 'v3.holdings.activity.kind.airdrop',
  opening_balance: 'v3.holdings.activity.kind.openingBalance',
  correction: 'v3.holdings.activity.kind.correction',
};

/** The fields of a ledger row its label is read from. */
export interface ActivityRow {
  kind: string;
  quantity: string;
  kindSubtype?: string | null;
  feeOf?: string | null;
}

/**
 * A dividend is labelled from its ledger subtype, because its legacy kind is
 * still `reward` (SC-1644), and the tax taken from it is a fee linked to it.
 * `dividendIds` are the dividend rows in the same list: a fee is called tax
 * only when the row it is linked to is one of them.
 *
 * A kind this build does not name — `unknown`, or one a newer server writes —
 * falls back to its direction rather than to the identifier.
 */
export function activityKindLabel(
  t: TFunction,
  row: ActivityRow,
  dividendIds: ReadonlySet<string>
): string {
  if (row.kindSubtype === 'dividend') return t('v3.holdings.activity.kind.dividend');
  if (row.kind === 'fee' && row.feeOf && dividendIds.has(row.feeOf)) {
    return t('v3.holdings.activity.kind.taxWithheld');
  }
  return t(KIND_KEYS[row.kind] ?? (row.quantity.trim().startsWith('-') ? MONEY_OUT : MONEY_IN));
}

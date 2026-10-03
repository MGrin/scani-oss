import { LEDGER_KINDS, type LedgerKind } from '../../../engine/types';
import type { MatchRule } from '../../../repositories/FeedMatchRuleRepository';
import type { OwnWalletAccount } from '../../../repositories/UserWalletRepository';

/** An entry with no destination, as the steps read it (D-10). */
export interface ClassifiableEntry {
  /** The account the entry's own holding sits in. */
  accountId: string;
  /** That account's `metadata.chainId`, as text; null off-chain. */
  chainKey: string | null;
  /** The counterparty in `normalizeCounterparty`'s own-wallet comparison form. */
  counterpartyAddress: string | null;
  /** The same counterparty through `transfer_counterparty_key`, computed by the database. */
  counterpartyKey: string | null;
  description: string | null;
}

export interface ClassificationContext {
  ownWallets: readonly OwnWalletAccount[];
  rules: readonly MatchRule[];
}

/** Written with `kind_origin 'rule'` (D-10). */
export interface ClassificationVerdict {
  ledgerKind?: LedgerKind;
  destinationAccountId?: string;
}

type ClassificationStep = (
  entry: ClassifiableEntry,
  ctx: ClassificationContext
) => ClassificationVerdict | null;

function normalizeDescription(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

const isLedgerKind = (value: string): value is LedgerKind =>
  (LEDGER_KINDS as readonly string[]).includes(value);

/**
 * Step 2: the counterparty is one of the user's wallets on the entry's chain.
 * The entry's own account is never a candidate, and exactly one other account
 * must remain (R45).
 */
const ownAddressStep: ClassificationStep = (entry, { ownWallets }) => {
  const { counterpartyAddress, chainKey } = entry;
  if (counterpartyAddress === null || chainKey === null) return null;
  const accounts = new Set(
    ownWallets
      .filter(
        (wallet) =>
          wallet.address === counterpartyAddress &&
          wallet.chainKey === chainKey &&
          wallet.accountId !== entry.accountId
      )
      .map((wallet) => wallet.accountId)
  );
  return accounts.size === 1 ? { destinationAccountId: [...accounts][0]! } : null;
};

function verdictOf(rule: MatchRule): ClassificationVerdict | null {
  const ledgerKind =
    rule.ledgerKind !== null && isLedgerKind(rule.ledgerKind) ? rule.ledgerKind : null;
  if (ledgerKind === null && rule.destinationAccountId === null) return null;
  return {
    ...(ledgerKind === null ? {} : { ledgerKind }),
    ...(rule.destinationAccountId === null
      ? {}
      : { destinationAccountId: rule.destinationAccountId }),
  };
}

/**
 * Step 3: a person's rule on the entry's input. Matching is exact on the
 * normalised forms; rules that match and disagree decide nothing.
 */
const userRuleStep: ClassificationStep = (entry, { rules }) => {
  const description = entry.description === null ? '' : normalizeDescription(entry.description);
  const verdicts = new Map<string, ClassificationVerdict>();
  for (const rule of rules) {
    const matches =
      rule.matchField === 'counterparty'
        ? rule.counterpartyKey !== null && rule.counterpartyKey === entry.counterpartyKey
        : description !== '' && normalizeDescription(rule.pattern) === description;
    const verdict = matches ? verdictOf(rule) : null;
    if (verdict === null) continue;
    verdicts.set(
      JSON.stringify([verdict.ledgerKind ?? null, verdict.destinationAccountId ?? null]),
      verdict
    );
  }
  return verdicts.size === 1 ? [...verdicts.values()][0]! : null;
};

/**
 * Steps 2 and 3 of D-10, in order. Step 1 is `mapLegacyEntry`, already on the
 * row; step 4 is the slot the Jev judgment takes.
 */
const CLASSIFICATION_STEPS: readonly ClassificationStep[] = [ownAddressStep, userRuleStep];

/** The first step's verdict that decides; null leaves the entry unclassified. */
export function decide(
  entry: ClassifiableEntry,
  ctx: ClassificationContext
): ClassificationVerdict | null {
  for (const step of CLASSIFICATION_STEPS) {
    const verdict = step(entry, ctx);
    if (verdict !== null) return verdict;
  }
  return null;
}

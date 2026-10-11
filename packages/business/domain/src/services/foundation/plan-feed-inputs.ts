import type { FeedInputStatus } from '@scani/db';
import { sourceForChainId, sourceForProvider } from '../transactions/transaction-source';

export const STATEMENT_INPUT_SOURCE = 'statement';
export const WALLET_FALLBACK_INPUT_SOURCE = 'wallet';
export const PROVIDER_INPUT_SOURCE_PREFIX = 'provider:';

/**
 * A budget app's register (YNAB, Actual, Mint): one input per account and app, and
 * statement-class evidence, since the person exported it (SC-1649). Not
 * `import_`, which names a provider's holdings.
 */
export const BUDGET_APP_SOURCE_PREFIX = 'budget-';
export type BudgetApp = 'ynab' | 'actual' | 'mint';
export function budgetAppSource(app: BudgetApp): string {
  return `${BUDGET_APP_SOURCE_PREFIX}${app}`;
}

export interface AccountInputFacts {
  userId: string;
  accountId: string;
  institutionName: string;
  chainId: string | number | null;
  walletId: string | null;
  walletActive: boolean;
  credentialId: string | null;
  credentialActive: boolean;
  hasProviderHoldings: boolean;
  hasCexLedger: boolean;
  hasStatementEvidence: boolean;
  /** A `blockchain` holding or a wallet-source ledger row on the account. */
  hasWalletEvidence: boolean;
}

export interface PlannedFeedInput {
  userId: string;
  accountId: string;
  source: string;
  credentialId: string | null;
  walletId: string | null;
  status: FeedInputStatus;
}

function statusOf(active: boolean): FeedInputStatus {
  return active ? 'active' : 'disconnected';
}

/** The chain an account's metadata names, which its wallet input is named by. */
export function accountChainId(metadata: unknown): string | number | null {
  const chainId = (metadata as { chainId?: unknown } | null)?.chainId;
  return typeof chainId === 'string' || typeof chainId === 'number' ? chainId : null;
}

/** The source of a wallet account's input: its chain's ledger source. */
export function walletInputSource(chainId: string | number | null | undefined): string {
  return sourceForChainId(chainId) ?? WALLET_FALLBACK_INPUT_SOURCE;
}

/** The source of a provider account's input: its ledger source, or one named for the institution. */
export function providerInputSource(institutionName: string): string {
  return (
    sourceForProvider(institutionName) ??
    `${PROVIDER_INPUT_SOURCE_PREFIX}${institutionName.toLowerCase()}`
  );
}

/** D-7: one input per (account, source), named by the ledger source it writes. */
export function planFeedInputs(facts: AccountInputFacts): PlannedFeedInput[] {
  const owner = { userId: facts.userId, accountId: facts.accountId };
  const planned: PlannedFeedInput[] = [];

  // As for a credential: a wallet that is gone leaves its rows behind, and the
  // chain still names the source they came from.
  if (facts.walletId !== null || (facts.chainId !== null && facts.hasWalletEvidence)) {
    planned.push({
      ...owner,
      source: walletInputSource(facts.chainId),
      credentialId: null,
      walletId: facts.walletId,
      status: statusOf(facts.walletId !== null && facts.walletActive),
    });
  }

  // A deleted credential leaves its holdings and ledger behind; the input stays,
  // disconnected, so those rows keep the source they came from.
  if (facts.hasProviderHoldings || facts.hasCexLedger) {
    planned.push({
      ...owner,
      source: providerInputSource(facts.institutionName),
      credentialId: facts.credentialId,
      walletId: null,
      status: statusOf(facts.credentialId !== null && facts.credentialActive),
    });
  }

  if (facts.hasStatementEvidence) {
    planned.push({
      ...owner,
      source: STATEMENT_INPUT_SOURCE,
      credentialId: null,
      walletId: null,
      status: 'active',
    });
  }

  return planned;
}

/**
 * What each input the account could have is brought up to once it exists: its
 * credential or wallet, and the status that connection gives (D-11). An input
 * that exists is its own evidence: ingest creates one before any holding or
 * ledger row exists, a run that fetched nothing included (R39), and D-7's
 * evidence decides only whether an input is created.
 */
export function planInputConnections(facts: AccountInputFacts): PlannedFeedInput[] {
  return planFeedInputs({
    ...facts,
    hasProviderHoldings: true,
    hasStatementEvidence: true,
    hasWalletEvidence: true,
  });
}

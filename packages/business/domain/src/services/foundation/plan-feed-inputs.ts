import type { FeedInputStatus } from '@scani/db';
import { sourceForChainId, sourceForProvider } from '../transactions/transaction-source';

export const STATEMENT_INPUT_SOURCE = 'statement';
export const WALLET_FALLBACK_INPUT_SOURCE = 'wallet';
export const PROVIDER_INPUT_SOURCE_PREFIX = 'provider:';

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

/** D-7: one input per (account, source), named by the ledger source it writes. */
export function planFeedInputs(facts: AccountInputFacts): PlannedFeedInput[] {
  const owner = { userId: facts.userId, accountId: facts.accountId };
  const planned: PlannedFeedInput[] = [];

  // As for a credential: a wallet that is gone leaves its rows behind, and the
  // chain still names the source they came from.
  if (facts.walletId !== null || (facts.chainId !== null && facts.hasWalletEvidence)) {
    planned.push({
      ...owner,
      source: sourceForChainId(facts.chainId) ?? WALLET_FALLBACK_INPUT_SOURCE,
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
      source:
        sourceForProvider(facts.institutionName) ??
        `${PROVIDER_INPUT_SOURCE_PREFIX}${facts.institutionName.toLowerCase()}`,
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

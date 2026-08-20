/**
 * Where to look a chain transaction up, and where its value went (SC-346).
 *
 * The transfer review queue asks "did this leave your portfolio?" about a row
 * whose only distinguishing marks are an amount and a date. For a chain
 * transfer that is not enough to remember by — mgrin's own answer to 560 of
 * them was "I honestly can not remember that anymore". The two facts that
 * make one identifiable are the address it went to and the transaction on a
 * block explorer, and both are already in the row.
 *
 * Kept in `@scani/shared` rather than beside the chain catalog in
 * `@scani/providers`: that package is a backend outbound adapter and this is
 * read by a React component. It is a small, stable table — a chain's explorer
 * changes about as often as its name.
 */

/** Explorer roots, keyed by EVM chain id. */
const EVM_EXPLORERS: Readonly<Record<number, string>> = {
  1: 'https://etherscan.io',
  10: 'https://optimistic.etherscan.io',
  56: 'https://bscscan.com',
  137: 'https://polygonscan.com',
  250: 'https://ftmscan.com',
  8453: 'https://basescan.org',
  42161: 'https://arbiscan.io',
  43114: 'https://snowtrace.io',
  59144: 'https://lineascan.build',
  534352: 'https://scrollscan.com',
};

/**
 * Non-EVM roots, keyed by the `holding_transactions.source` tag.
 *
 * These have no chain id — `accounts.metadata.chainId` carries sentinels for
 * them (Solana is -2, Bitcoin 0), which are an internal encoding and not
 * something to key public URLs on.
 */
const SOURCE_EXPLORERS: Readonly<Record<string, { tx: string; address: string }>> = {
  solana: { tx: 'https://solscan.io/tx/', address: 'https://solscan.io/account/' },
  bitcoin: { tx: 'https://mempool.space/tx/', address: 'https://mempool.space/address/' },
  ton: { tx: 'https://tonscan.org/tx/', address: 'https://tonscan.org/address/' },
  tron: { tx: 'https://tronscan.org/#/transaction/', address: 'https://tronscan.org/#/address/' },
};

export interface ExplorerLinks {
  /** The transaction on its chain's explorer, or null if we cannot name one. */
  transactionUrl: string | null;
  /** The counterparty address on the same explorer, or null. */
  addressUrl: string | null;
}

/**
 * Both links for one row, or nulls.
 *
 * Returns null rather than guessing a root: a wrong explorer link is worse
 * than none, because it reads as authoritative and sends the reader to a
 * page that says the transaction does not exist — which is exactly the
 * doubt this feature exists to remove.
 */
export function explorerLinks(
  source: string,
  chainId: number | null | undefined,
  txHash: string | null | undefined,
  address: string | null | undefined
): ExplorerLinks {
  const bySource = SOURCE_EXPLORERS[source];
  if (bySource) {
    return {
      transactionUrl: txHash ? `${bySource.tx}${txHash}` : null,
      addressUrl: address ? `${bySource.address}${address}` : null,
    };
  }

  const root = typeof chainId === 'number' ? EVM_EXPLORERS[chainId] : undefined;
  if (!root) return { transactionUrl: null, addressUrl: null };
  return {
    transactionUrl: txHash ? `${root}/tx/${txHash}` : null,
    addressUrl: address ? `${root}/address/${address}` : null,
  };
}

/**
 * The counterparty of a chain transfer, read from the row's own payload.
 *
 * `holding_transactions.counterparty` is the column that should hold this,
 * and for `etherscan` rows it is still NULL: the backfill that fills it
 * (SC-329) runs nightly at 05:30 UTC and the extractor only started working
 * today. Rather than leave the review queue blank until then — and blank
 * again for every wallet imported between two sweeps — the address is read
 * here from the payload the row already carries.
 *
 * Direction matters and is not guessable: for an outflow the counterparty is
 * `to`, for an inflow it is `from`. An unknown kind returns null instead of
 * choosing, because an address pointing the wrong way says the user paid
 * themselves.
 */
export function counterpartyFromPayload(
  kind: string,
  rawPayload: unknown,
  stored: string | null
): string | null {
  if (stored) return stored;
  const payload = typeof rawPayload === 'object' && rawPayload !== null ? rawPayload : null;
  if (!payload) return null;
  const record = payload as Record<string, unknown>;
  const field = OUTFLOW_KINDS.has(kind) ? 'to' : INFLOW_KINDS.has(kind) ? 'from' : null;
  if (!field) return null;
  const value = record[field];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The one form an address is compared in — lowercased and trimmed (SC-375).
 *
 * A function rather than a `.trim().toLowerCase()` at each site because the
 * comparison happens in more than one place and they must agree exactly: the
 * queue's own-wallet badge and the own-wallet guard the disposal audit runs
 * with. EVM addresses travel in EIP-55 mixed case and the two sides come from
 * different places — `user_wallets` holds what a person pasted, the
 * counterparty comes out of a chain payload — so a single missed `toLowerCase`
 * is a wallet reported as a stranger's.
 *
 * **This is not the rule key.** SC-375 used this for both, and SC-381 split
 * them: a rule is matched on `transfer_counterparty_key`, a SQL function that
 * also strips the `Pay <amount> <CCY> to ` preamble a payment rail writes,
 * because the amount is per-transaction and a rule carrying it fires once.
 * That normalization lives in the database and has exactly one implementation
 * — the authoring path selects it rather than computing it — which is what
 * keeps the string written and the string matched identical.
 *
 * Null in, null out; whitespace-only in, null out — an address that normalizes
 * to the empty string is not an address, and a rule keyed on `''` would match
 * every row with no destination at all.
 */
export function normalizeCounterparty(address: string | null | undefined): string | null {
  if (typeof address !== 'string') return null;
  const normalized = address.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

const OUTFLOW_KINDS = new Set(['transfer_out', 'withdraw', 'swap_out', 'sell']);
const INFLOW_KINDS = new Set(['transfer_in', 'deposit', 'swap_in', 'buy', 'airdrop']);

/** The chain transaction hash a row came from, if it has one. */
export function txHashFromPayload(rawPayload: unknown, externalId: string | null): string | null {
  const payload = typeof rawPayload === 'object' && rawPayload !== null ? rawPayload : null;
  const fromPayload = payload ? (payload as Record<string, unknown>).hash : undefined;
  if (typeof fromPayload === 'string' && fromPayload.trim().length > 0) return fromPayload.trim();
  // `external_id` is `hash-contract` for ERC-20 rows and the bare hash for
  // native ones (SC-341 is the ticket for that key being lossy). Either way
  // the leading 0x-prefixed 64 hex chars are the transaction.
  const match = externalId?.match(/^(0x[0-9a-fA-F]{64})/);
  return match?.[1] ?? null;
}

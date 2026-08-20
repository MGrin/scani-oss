import type { ReviewDetail } from '@scani/shared';

/**
 * What a pending review actually contains, in operands.
 *
 * Without it the feed renders identical rows — two "Screenshot import /
 * 5/18/2026" cards with nothing to tell them apart — on the one page whose
 * job is to say what needs attention.
 *
 * One reader per reviewable kind, each pinned to the result shape its worker
 * actually returns. An earlier version had a single holdings-shaped reader
 * and claimed to cover file-import too; that branch was dead, because
 * file-import never produces holdings on the path that reaches this feed. A
 * kind with no reader gets no detail, which is honest; a kind with the wrong
 * one gets silence that looks like coverage.
 *
 * These used to return English sentences — `3 holdings · BTC, ETH`, with
 * their own pluralisation — which is why /review could not be translated
 * (SC-371). They return the counts now and the client says them. Nothing
 * here decides how a row reads: not the cap on the symbol list, not the
 * casing of the file type, not the separator.
 *
 * Total by design: it runs while rendering the feed, so an unexpected
 * shape must yield undefined rather than take the page down. Every
 * accessor below is defensive for that reason.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** screenshot-parse: `{ results: [{ data: { holdings: [...] } }] }` */
function readScreenshotParse(result: unknown): ReviewDetail | undefined {
  const root = asRecord(result);
  if (!root || !Array.isArray(root.results)) return undefined;

  const holdings: Array<Record<string, unknown>> = [];
  for (const entry of root.results) {
    const data = asRecord(asRecord(entry)?.data);
    if (!data || !Array.isArray(data.holdings)) continue;
    for (const holding of data.holdings) {
      const rec = asRecord(holding);
      if (rec) holdings.push(rec);
    }
  }
  if (holdings.length === 0) return undefined;

  const symbols: string[] = [];
  for (const holding of holdings) {
    const symbol = holding.symbol;
    if (typeof symbol === 'string' && symbol && !symbols.includes(symbol)) symbols.push(symbol);
  }

  return { code: 'parsedHoldings', holdings: holdings.length, symbols };
}

/**
 * file-import: the worker auto-stamps `action_taken_at` on every path
 * except the `needsCurrency` early return, so that is the only shape that
 * can reach this feed. Naming the blocker is the useful part — the row
 * exists precisely because a currency choice is outstanding.
 */
function readFileImport(result: unknown): ReviewDetail | undefined {
  const pending = asRecord(asRecord(result)?.needsCurrency);
  if (!pending) return undefined;

  const count = asPositiveInt(pending.transactionCount);
  if (count === null) return undefined;

  const fileType =
    typeof pending.fileType === 'string' && pending.fileType ? pending.fileType : undefined;
  return { code: 'transactionsNeedCurrency', transactions: count, fileType };
}

/** wallet-import: `{ walletLabel, chainsDetected, candidateCount }` */
function readWalletImport(result: unknown): ReviewDetail | undefined {
  const root = asRecord(result);
  if (!root) return undefined;

  const chains = asPositiveInt(root.chainsDetected);
  const candidates = asPositiveInt(root.candidateCount);
  if (chains === null || candidates === null) return undefined;

  const label =
    typeof root.walletLabel === 'string' && root.walletLabel ? root.walletLabel : undefined;
  // A sweep that found nothing is worth saying out loud, and `candidates: 0`
  // is what says it: it explains an otherwise-empty review without the user
  // opening the job. The client owns the wording.
  return { code: 'walletCandidates', walletLabel: label, candidates, chains };
}

const READERS: Record<string, (result: unknown) => ReviewDetail | undefined> = {
  'screenshot-parse': readScreenshotParse,
  'file-import': readFileImport,
  'wallet-import': readWalletImport,
};

export function describePendingReview(jobName: string, result: unknown): ReviewDetail | undefined {
  return READERS[jobName]?.(result);
}

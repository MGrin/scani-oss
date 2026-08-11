/**
 * One-line description of what a pending review actually contains.
 *
 * Without it the feed renders identical rows — two "Screenshot import /
 * 5/18/2026" cards with nothing to tell them apart — on the one page whose
 * job is to say what needs attention.
 *
 * One summariser per reviewable kind, each pinned to the result shape its
 * worker actually returns. An earlier version had a single holdings-shaped
 * reader and claimed to cover file-import too; that branch was dead,
 * because file-import never produces holdings on the path that reaches
 * this feed. A kind with no summariser gets no subtitle, which is honest;
 * a kind with the wrong one gets silence that looks like coverage.
 *
 * Total by design: it runs while rendering the feed, so an unexpected
 * shape must yield undefined rather than take the page down. Every
 * accessor below is defensive for that reason.
 */

const MAX_SYMBOLS = 3;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** screenshot-parse: `{ results: [{ data: { holdings: [...] } }] }` */
function summariseScreenshotParse(result: unknown): string | undefined {
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

  const noun = plural(holdings.length, 'holding');
  if (symbols.length === 0) return noun;

  const shown = symbols.slice(0, MAX_SYMBOLS).join(', ');
  const overflow = symbols.length - MAX_SYMBOLS;
  return overflow > 0 ? `${noun} · ${shown} +${overflow}` : `${noun} · ${shown}`;
}

/**
 * file-import: the worker auto-stamps `action_taken_at` on every path
 * except the `needsCurrency` early return, so that is the only shape that
 * can reach this feed. Naming the blocker is the useful part — the row
 * exists precisely because a currency choice is outstanding.
 */
function summariseFileImport(result: unknown): string | undefined {
  const pending = asRecord(asRecord(result)?.needsCurrency);
  if (!pending) return undefined;

  const count = asPositiveInt(pending.transactionCount);
  if (count === null) return undefined;

  const fileType = typeof pending.fileType === 'string' ? pending.fileType : '';
  const head = fileType
    ? `${plural(count, 'transaction')} · ${fileType.toUpperCase()}`
    : plural(count, 'transaction');
  return `${head} — needs a currency`;
}

/** wallet-import: `{ walletLabel, chainsDetected, candidateCount }` */
function summariseWalletImport(result: unknown): string | undefined {
  const root = asRecord(result);
  if (!root) return undefined;

  const chains = asPositiveInt(root.chainsDetected);
  const candidates = asPositiveInt(root.candidateCount);
  if (chains === null || candidates === null) return undefined;

  const label = typeof root.walletLabel === 'string' && root.walletLabel ? root.walletLabel : '';
  // A sweep that found nothing is worth saying out loud: it explains an
  // otherwise-empty review without the user opening the job.
  const body =
    candidates === 0
      ? 'nothing found'
      : `${plural(candidates, 'candidate')} across ${plural(chains, 'chain')}`;
  return label ? `${label} · ${body}` : body;
}

const SUMMARISERS: Record<string, (result: unknown) => string | undefined> = {
  'screenshot-parse': summariseScreenshotParse,
  'file-import': summariseFileImport,
  'wallet-import': summariseWalletImport,
};

export function summarisePendingReview(jobName: string, result: unknown): string | undefined {
  return SUMMARISERS[jobName]?.(result);
}

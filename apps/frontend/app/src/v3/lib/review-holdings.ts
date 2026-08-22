import { collidingHoldingTokens, contestedHoldingTokens } from '@scani/shared';

/**
 * What a parsed statement proposes, and what confirming it will actually write.
 *
 * v2 computes all of this inline inside `ReviewHoldingsCard`, which is why the
 * two numbers it produces are allowed to disagree: the header counts matched
 * rows and the payload builder filters those again on `h.balance`, so a row
 * whose amount was cleared is counted by the button and dropped by the save.
 * Here the count and the payload read the same `importable` list, and a row
 * that cannot be written blocks the save instead of vanishing from it.
 *
 * It is pure on purpose. The collision rule is the one the server refuses on
 * (`holdingPositionKey` in `@scani/shared`), and a rule that only exists inside
 * a component is a rule nothing asserts.
 */

export interface ReviewHoldingInput {
  symbol: string;
  name?: string | null;
  /** AI-classified asset type (fiat / crypto / stock), when available. */
  assetType?: 'fiat' | 'crypto' | 'stock' | null;
  /** Canonical, never formatted. `''` when the extractor read no figure. */
  balance: string;
  confidence?: number | null;
  tokenId?: string | null;
  holdingId?: string | null;
  existingBalance?: string | null;
  /** The name already on the matched holding, for `update` rows (SC-330). */
  existingLabel?: string | null;
}

export interface ReviewRow extends ReviewHoldingInput {
  /** Stable across edits. Positional rather than random: rows are never
   *  reordered or appended, so the index IS the identity, and a random one
   *  cannot be asserted about. */
  rowId: string;
  removed: boolean;
  /** What the reader calls this pot. Only ever typed on rows that CREATE, and
   *  only asked for when the token is contested. */
  label: string;
}

export function toReviewRows(holdings: readonly ReviewHoldingInput[]): ReviewRow[] {
  return holdings.map((holding, index) => ({
    ...holding,
    // No `?? '0'`. A missing figure is a figure the extractor could not read,
    // and defaulting it to zero turns that into a claim that the position is
    // empty — on the one screen built for a human to catch exactly that.
    balance: typeof holding.balance === 'string' ? holding.balance : '',
    label: '',
    removed: false,
    rowId: `row-${index}`,
  }));
}

/**
 * Why the save is refused. One reason at a time, most consequential first: a
 * duplicate position is the one that writes something wrong, a missing amount
 * is the one that writes less than the reader is looking at.
 */
type ReviewBlocker = 'duplicatePosition' | 'missingAmount' | 'nothingToImport';

export interface ReviewState {
  active: ReviewRow[];
  /** Active, matched to a token, not pointing at an existing holding. */
  creating: ReviewRow[];
  /** Active, pointing at an existing holding. */
  updating: ReviewRow[];
  /** Active, no token — nothing can be written for these. */
  unmatched: ReviewRow[];
  /** Active and matched, but with no amount to write. */
  incomplete: ReviewRow[];
  /** Tokens this payload puts on more than one row — the rows that must say
   *  WHICH position they are. Label-blind, so the question does not withdraw
   *  itself the moment the first answer is typed. */
  contestedTokenIds: Set<string>;
  /** Symbols still on two rows under the same name — the unresolved half. */
  collidingSymbols: string[];
  removedCount: number;
  /** What the button promises, and exactly what `buildBatchPayload` writes. */
  importableCount: number;
  blocker: ReviewBlocker | null;
}

function hasAmount(row: ReviewRow): boolean {
  return row.balance.trim().length > 0;
}

export function deriveReviewState(rows: readonly ReviewRow[]): ReviewState {
  const active = rows.filter((row) => !row.removed);
  const creating = active.filter((row) => row.tokenId && !row.holdingId);
  const updating = active.filter((row) => row.holdingId);
  const unmatched = active.filter((row) => !row.tokenId);
  const incomplete = [...creating, ...updating].filter((row) => !hasAmount(row));

  // An update row occupies the key of the holding it points at, whose stored
  // name arrived as `existingLabel`. Dropping that field is what makes this
  // guard both refuse imports the server would accept and pass ones it
  // refuses — see `readScreenshotParse`, which is where v2 dropped it.
  const contestedTokenIds = contestedHoldingTokens(
    creating.map((row) => ({ tokenId: row.tokenId as string })),
    updating.filter((row) => row.tokenId).map((row) => ({ tokenId: row.tokenId as string }))
  );
  const colliding = collidingHoldingTokens(
    creating.map((row) => ({ tokenId: row.tokenId as string, label: row.label })),
    updating
      .filter((row) => row.tokenId)
      .map((row) => ({ tokenId: row.tokenId as string, label: row.existingLabel }))
  );
  const collidingSymbols = [
    ...new Set(
      active.filter((row) => row.tokenId && colliding.has(row.tokenId)).map((r) => r.symbol)
    ),
  ];

  const importableCount = creating.length + updating.length;

  let blocker: ReviewBlocker | null = null;
  if (collidingSymbols.length > 0) blocker = 'duplicatePosition';
  else if (incomplete.length > 0) blocker = 'missingAmount';
  else if (importableCount === 0) blocker = 'nothingToImport';

  return {
    active,
    creating,
    updating,
    unmatched,
    incomplete,
    contestedTokenIds,
    collidingSymbols,
    removedCount: rows.length - active.length,
    importableCount,
    blocker,
  };
}

export interface BatchImportPayload {
  requestId: string;
  accountId: string;
  newHoldings: Array<{ tokenId: string; balance: string; label?: string }>;
  updateHoldings: Array<{ holdingId: string; balance: string }>;
  parentJobIdToStampOnSuccess?: string;
}

/**
 * Null when the state is blocked, so the only way to write is through a state
 * that permits it. There is deliberately no filter here that `importableCount`
 * does not also apply — that divergence is the v2 defect this file exists to
 * make impossible.
 */
export function buildBatchPayload(
  state: ReviewState,
  options: { accountId: string; jobId?: string; requestId: string }
): BatchImportPayload | null {
  if (state.blocker) return null;
  return {
    requestId: options.requestId,
    accountId: options.accountId,
    newHoldings: state.creating.map((row) => ({
      tokenId: row.tokenId as string,
      balance: row.balance.trim(),
      // Only sent when the reader was actually asked. A name typed into a row
      // whose token later stopped colliding is not a name they chose to keep,
      // and storing it would put a stray "Savings" on a lone holding.
      label:
        state.contestedTokenIds.has(row.tokenId as string) && row.label.trim()
          ? row.label.trim()
          : undefined,
    })),
    updateHoldings: state.updating.map((row) => ({
      holdingId: row.holdingId as string,
      balance: row.balance.trim(),
    })),
    parentJobIdToStampOnSuccess: options.jobId,
  };
}

/**
 * What a `screenshot-parse` job returned, narrowed rather than asserted.
 *
 * Two things here are not v2's. The per-file counts are derived from the
 * `results` array instead of read out of `summary`: a row written before the
 * worker recorded a summary rendered "0 succeeded, 0 failed" directly above a
 * list of extracted holdings, because those two numbers had different sources.
 * And `existingLabel` survives the mapping — v2's aggregation lists every other
 * enriched field and omits that one, which silently disables both halves of the
 * duplicate-position guard downstream (SC-303, SC-330).
 */
type ParsedFileKind = 'image' | 'pdf' | 'mixed';

export interface ScreenshotParseSummary {
  accountId: string | null;
  totalFiles: number;
  succeeded: number;
  failed: number;
  kind: ParsedFileKind;
  holdings: ReviewHoldingInput[];
  /** Only when a single file was read — averaging two files' confidence would
   *  be a number no extractor produced. */
  overallConfidence: number | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function readHolding(value: unknown): ReviewHoldingInput {
  const row = asRecord(value);
  const assetType = row.assetType;
  return {
    symbol: typeof row.symbol === 'string' ? row.symbol : '',
    name: typeof row.name === 'string' ? row.name : null,
    assetType:
      assetType === 'fiat' || assetType === 'crypto' || assetType === 'stock' ? assetType : null,
    balance: row.balance === null || row.balance === undefined ? '' : String(row.balance),
    confidence: typeof row.confidence === 'number' ? row.confidence : null,
    tokenId: typeof row.tokenId === 'string' ? row.tokenId : null,
    holdingId: typeof row.holdingId === 'string' ? row.holdingId : null,
    existingBalance: typeof row.existingBalance === 'string' ? row.existingBalance : null,
    existingLabel: typeof row.existingLabel === 'string' ? row.existingLabel : null,
  };
}

export function readScreenshotParse(result: unknown): ScreenshotParseSummary {
  const root = asRecord(result);
  const files = (Array.isArray(root.results) ? root.results : []).map(asRecord);
  const summary = asRecord(root.summary);

  const successes = files.filter((file) => file.success === true);
  const declaredTotal = typeof summary.totalFiles === 'number' ? summary.totalFiles : 0;

  const extensions = files.map((file) =>
    (typeof file.r2Key === 'string' ? file.r2Key : '').toLowerCase().endsWith('.pdf')
      ? 'pdf'
      : 'image'
  );
  const kind: ParsedFileKind =
    extensions.length > 0 && extensions.every((e) => e === 'pdf')
      ? 'pdf'
      : extensions.every((e) => e === 'image')
        ? 'image'
        : // A PDF beside a screenshot is neither, and calling the pair
          // "screenshots" is how a bank statement got told to be re-cropped.
          'mixed';

  const holdings = successes.flatMap((file) => {
    const rows = asRecord(file.data).holdings;
    return (Array.isArray(rows) ? rows : []).map(readHolding);
  });

  const single = successes.length === 1 ? asRecord(asRecord(successes[0]).data) : null;

  return {
    accountId:
      typeof root.accountId === 'string' && root.accountId.length > 0 ? root.accountId : null,
    totalFiles: Math.max(declaredTotal, files.length),
    succeeded: successes.length,
    failed: files.length - successes.length,
    kind,
    holdings,
    overallConfidence:
      single && typeof single.overallConfidence === 'number' ? single.overallConfidence : null,
  };
}

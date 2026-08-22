/**
 * What a `wallet-import` job result means, separated from what it looks like.
 *
 * v2 keeps all of this inside the renderer, and every defect this job kind has
 * had was an interpretation rather than a layout: a failed chain fetch reported
 * as "0 tokens across 0 chains" (SC-139), and a payload that never arrived
 * reported as a provider rejection that never happened (SC-145). The invariant
 * those two fixes established holds here and is the reason the module exists —
 * **"we could not read this" and "this is empty" are opposite answers about
 * somebody's money and must never collapse into one.**
 *
 * Two things are decided here that v2 decides inline, and both are the kind of
 * rule that needs asserting without a DOM:
 *
 * - **What the confirm button will actually write.** v2's spam filter hides
 *   rows without touching the selection, so a reader who ticks everything with
 *   the filter off and then turns it back on is offered "Import 31 holdings"
 *   over a list of nine. The count is the payload either way; what was missing
 *   is that the rows behind it were off screen with nothing saying so.
 * - **Which rows are spam.** v2 flags any symbol or name containing a Cyrillic
 *   letter, on the reading that Cyrillic means a homoglyph attack. In an app
 *   that ships a Russian interface that is a rule against a language: a token
 *   named in Russian is unticked and hidden by default. A homoglyph is Latin
 *   and Cyrillic inside ONE word, which is what `mixedScript` tests.
 */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** A number field, tolerating the array form older results used. */
function asCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return Array.isArray(value) ? value.length : 0;
}

/**
 * Per-chain failures, flattened to one line each.
 *
 * The producer pushes `{chainId, chainName, error}`
 * (`ImportWalletAddressUseCase.fetchChainData`), but older rows carry bare
 * strings and nothing stops a future shape, so anything unrecognised is
 * stringified rather than dropped. A failure the user never sees is the whole
 * defect (SC-139).
 */
export function readChainErrors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === 'string') return entry;
    const record = asRecord(entry);
    const message = typeof record.error === 'string' ? record.error : JSON.stringify(entry);
    const chain = typeof record.chainName === 'string' ? record.chainName : null;
    return chain && chain !== 'Unknown' ? `${chain}: ${message}` : message;
  });
}

/**
 * What the balance fetch established, as opposed to what it returned.
 *
 * `empty` and `unreadable` are the two v2's review card collapsed into a single
 * "0 tokens" line.
 */
export type WalletFetchOutcome = 'found' | 'partial' | 'empty' | 'unreadable';

export function classifyWalletFetch(
  candidateCount: number,
  failedChains: number
): WalletFetchOutcome {
  if (candidateCount > 0) return failedChains > 0 ? 'partial' : 'found';
  return failedChains > 0 ? 'unreadable' : 'empty';
}

/**
 * Why a row is unticked, rather than whether it is.
 *
 * A boolean can only be rendered as a warning triangle, and the reader's
 * question at a row that arrived unticked is *why*. Both values are also the
 * two different mistakes the heuristic can make, so a false positive is legible
 * as one.
 */
export type SpamSignal = 'solicitation' | 'mixedScript';

const SOLICITATION = /(t\.me|t\.ly|claim|airdrop|reward|swap-based|[$]\s*\d|opensea|metawin)/i;

const CYRILLIC = /[Ѐ-ӿ]/;
const LATIN = /[A-Za-z]/;

/**
 * One word carrying both alphabets — `USDС` with a Cyrillic `С`.
 *
 * Per word, not per string: `Сбербанк RUB` is a Russian name beside a Latin
 * ticker and is not an attack, while v2's whole-string test flags it. Splitting
 * on whitespace is what keeps the two apart.
 */
function hasMixedScriptWord(text: string): boolean {
  return text
    .split(/\s+/)
    .some((word) => word.length > 0 && CYRILLIC.test(word) && LATIN.test(word));
}

export function spamSignal(symbol: string | null, name: string | null): SpamSignal | null {
  const parts = `${symbol ?? ''} ${name ?? ''}`;
  if (SOLICITATION.test(parts)) return 'solicitation';
  if (hasMixedScriptWord(parts)) return 'mixedScript';
  return null;
}

export interface WalletCandidate {
  /** `${institutionId}:${externalId}`. Keyed by both so one token address held
   *  on two chains stays two rows the confirm can tell apart. */
  key: string;
  institutionId: string;
  externalId: string;
  symbol: string | null;
  name: string | null;
  /** The provider's decimal-adjusted figure, canonical and never formatted. */
  balance: string;
  spam: SpamSignal | null;
}

export interface WalletChainGroup {
  institutionId: string;
  institutionName: string;
  candidates: WalletCandidate[];
}

interface WalletReviewView {
  kind: 'review';
  chains: WalletChainGroup[];
  /** How many chains the ADDRESS was found on — never how many answered.
   *  Reporting the latter as the former is SC-139. */
  chainsDetected: number;
  errors: string[];
  totalCandidates: number;
  spamCount: number;
  outcome: WalletFetchOutcome;
}

interface WalletUnavailableView {
  kind: 'unavailable';
  candidateCount: number;
  chainsDetected: number;
  errors: string[];
}

interface WalletImportedView {
  kind: 'imported';
  /** Insertion order from the job result — the order the rows render in, so a
   *  price refetch cannot shuffle them. */
  holdingIds: string[];
  accountsCreated: number;
  holdingsCreated: number;
  chainNames: string[];
  chainsDetected: number;
  errors: string[];
}

export type WalletImportView = WalletReviewView | WalletUnavailableView | WalletImportedView;

export function readWalletImport(result: unknown): WalletImportView {
  const record = asRecord(result);
  const errors = readChainErrors(record.errors);
  const chainsDetectedRaw = record.chainsDetected;
  const chainsDetected = asCount(chainsDetectedRaw);

  if (record.needsReview === true) {
    // A review payload whose `chains` is not an array is a payload we did not
    // receive, not an import that produced nothing. Falling through to the
    // imported branch here is what told someone holding 2,766 tokens that a
    // provider had rejected their balance fetch (SC-145).
    if (!Array.isArray(record.chains)) {
      return {
        kind: 'unavailable',
        candidateCount: asCount(record.candidateCount),
        chainsDetected,
        errors,
      };
    }
    const chains = record.chains.map(readChainGroup);
    const totalCandidates = chains.reduce((total, chain) => total + chain.candidates.length, 0);
    const spamCount = chains.reduce(
      (total, chain) => total + chain.candidates.filter((row) => row.spam !== null).length,
      0
    );
    return {
      kind: 'review',
      chains,
      chainsDetected: Math.max(chainsDetected, chains.length),
      errors,
      totalCandidates,
      spamCount,
      outcome: classifyWalletFetch(totalCandidates, errors.length),
    };
  }

  return {
    kind: 'imported',
    holdingIds: Array.isArray(record.holdingIds)
      ? record.holdingIds.filter((id): id is string => typeof id === 'string')
      : [],
    accountsCreated: asCount(record.accountsCreated),
    holdingsCreated: asCount(record.holdingsCreated),
    chainNames: Array.isArray(chainsDetectedRaw)
      ? chainsDetectedRaw.filter((name): name is string => typeof name === 'string')
      : [],
    chainsDetected,
    errors,
  };
}

function readChainGroup(value: unknown): WalletChainGroup {
  const chain = asRecord(value);
  const institutionId = typeof chain.institutionId === 'string' ? chain.institutionId : '';
  const snapshots = Array.isArray(chain.snapshots) ? chain.snapshots : [];
  return {
    institutionId,
    institutionName: typeof chain.institutionName === 'string' ? chain.institutionName : '',
    candidates: snapshots.map((entry) => {
      const snapshot = asRecord(entry);
      const identity = asRecord(snapshot.tokenIdentity);
      const externalId = typeof snapshot.externalId === 'string' ? snapshot.externalId : '';
      const symbol = typeof identity.symbol === 'string' ? identity.symbol : null;
      const name = typeof identity.name === 'string' ? identity.name : null;
      return {
        key: `${institutionId}:${externalId}`,
        institutionId,
        externalId,
        symbol,
        name,
        balance: typeof snapshot.balance === 'string' ? snapshot.balance : '',
        spam: spamSignal(symbol, name),
      };
    }),
  };
}

export interface WalletSelectionState {
  /** Chains with their filtered rows, chains that filtered to nothing dropped. */
  groups: WalletChainGroup[];
  /** Rows on screen right now. */
  visibleCount: number;
  /** Ticked rows the filter is hiding — what the button would write and the
   *  reader cannot see. Non-empty is a thing the card has to say out loud. */
  hiddenSelected: WalletCandidate[];
  /** Exactly what `wallet.confirmHoldings` receives. Derived from the same
   *  selection the count renders, so the two cannot disagree. */
  kept: Array<{ institutionId: string; externalId: string }>;
}

export function deriveWalletSelection(
  chains: readonly WalletChainGroup[],
  selected: ReadonlySet<string>,
  hideSpam: boolean
): WalletSelectionState {
  const groups: WalletChainGroup[] = [];
  const hiddenSelected: WalletCandidate[] = [];
  let visibleCount = 0;

  for (const chain of chains) {
    const candidates = chain.candidates.filter((row) => {
      const hidden = hideSpam && row.spam !== null;
      if (hidden && selected.has(row.key)) hiddenSelected.push(row);
      return !hidden;
    });
    visibleCount += candidates.length;
    if (candidates.length > 0) groups.push({ ...chain, candidates });
  }

  // Over the chains rather than over `selected`, so a key left behind by a
  // payload that changed shape cannot reach the mutation.
  const kept = chains
    .flatMap((chain) => chain.candidates)
    .filter((row) => selected.has(row.key))
    .map((row) => ({ institutionId: row.institutionId, externalId: row.externalId }));

  return { groups, visibleCount, hiddenSelected, kept };
}

/** The rows a fresh review starts ticked: everything the heuristic did not
 *  flag, so a wallet holding 200 airdropped tokens opens clean. */
export function initialWalletSelection(chains: readonly WalletChainGroup[]): Set<string> {
  return new Set(
    chains.flatMap((chain) =>
      chain.candidates.filter((row) => row.spam === null).map((row) => row.key)
    )
  );
}

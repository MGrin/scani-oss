import { createHash } from 'node:crypto';

/**
 * What tree a committed baseline is a picture of (SC-833).
 *
 * ## The blind spot this sits in
 *
 * A baseline records WHAT it shows and nothing about WHERE it came from. Not
 * the commit, not whether the checkout was current, not whether the files that
 * produced the pixels were the committed ones. So a baseline written from a
 * stale or dirty checkout is a perfectly stable, perfectly rendered picture of
 * a tree nobody will ever have again — and it becomes the permanent
 * expectation every later run is measured against.
 *
 * This is not SC-832 and not SC-867. Those are "the capture never settled":
 * the pixels are WRONG, and `assertPixelsSettled`, `assertPhotographedOnce`
 * and `baselineCollapse` each report a cause of that. Here the pixels are
 * exactly RIGHT — they are just of the wrong tree, and every one of those
 * checks agrees with them. `assertPhotographedOnce` fires on a mid-capture
 * reload and has nothing to say about which commit was rendered.
 *
 * It nearly happened. Mid-SC-825, before a regeneration run, `origin/main` was
 * four commits ahead of the checkout and nothing anywhere said so. It came
 * back harmless only by hand inspection: both differing files were under
 * `apps/frontend/landing`, and the gate photographs the app. Had they been
 * under `apps/frontend/app`, eight baselines would have been written from a
 * stale tree, committed, merged, and agreed with forever.
 *
 * ## Why this RECORDS and does not REFUSE
 *
 * The choice is the design question in the ticket and it is not the default.
 * Four reasons, and the first is decisive on its own:
 *
 * 1. **Every trigger a refusal could key on is the NORMAL path.** A dirty tree
 *    is not an anomaly during a regeneration, it is the whole workflow: you
 *    change the app, then run `--update` to move the baselines your change
 *    moved. A guard that fired there would fire on every legitimate use and be
 *    switched off inside a week — which is precisely why `gate-db`'s mtime
 *    clause reports rather than refuses, over the suite's own housekeeping.
 * 2. **Being behind main does not make a baseline WRONG, it makes it
 *    UNATTRIBUTABLE**, and the remedy for unattributable is attribution.
 *    `gate-db`'s `base MOVED` clause — the closest analogue in this
 *    repository, and the precedent the ticket names — says "the tests are
 *    valid for this tree; what would LAND is not this tree" and exits 0.
 *    Refusing here would be stricter than that precedent with no measurement
 *    showing the reporting standard insufficient.
 * 3. **The question is not answerable at write time with the confidence a
 *    refusal needs.** `origin/main` is a local ref whose freshness depends on
 *    a fetch nobody ran, so a refusal could rest on a reading that is itself
 *    stale. `gate-db` already named that state UNCONFIRMED and did not treat
 *    it as a failure; see `describeBase` below, which keeps the same four
 *    forms.
 * 4. **Unlike a verdict line, this record OUTLIVES the run.** A baseline is
 *    reviewed as an image diff in a PR — CLAUDE.md says so, and calls them
 *    migrations. A manifest committed beside `__screenshots__/` changes in the
 *    same diff, so the provenance reaches a reader at the moment the decision
 *    is actually made, which is later and better than capture time.
 *
 * What that buys is a red arm a write-time refusal could never have:
 * `manifestDrift` compares the committed rows against the PNGs on disk, so a
 * baseline whose bytes came from somewhere this harness did not write — a hand
 * edit, a conflict resolution that took the PNG and not the manifest, a
 * cherry-pick — is reportable after the fact.
 *
 * ## What it cannot claim, measured rather than asserted
 *
 * **The digest is of the SOURCE TREE, never of the bundle the browser was
 * served.** The stack serves the SPA from a Vite dev server that was started
 * before the run, and a dev server does not always pick up an edit — so a
 * record reading `clean at <sha>` is compatible with a picture of whatever
 * that server had compiled. The honest claim tops out at *the checkout that
 * produced this PNG looked like this*, and never reaches *the pixels are of
 * this source*. Same shape as `gate-db`'s mtime clause, which claims "nothing
 * WROTE a tracked path" and deliberately not "the tree did not change".
 *
 * It also says nothing about a hand-placed PNG whose manifest row was
 * hand-written to match. Provenance is a record, not a signature.
 */

/**
 * The paths whose content can reach a baseline.
 *
 * **Scoping this is the control, not a shortcut.** The incident above was
 * harmless because the drift was under `apps/frontend/landing`, which the gate
 * never photographs; a check that fired on it would be noise, and noise is how
 * a check stops being read. So the set is the SPA's workspace closure —
 * `apps/frontend/app` depends on `@scani/ui` and `@scani/shared`, and `@scani/ui`
 * on `@scani/shared` — plus the harness that decides what is photographed and
 * what the session holds.
 *
 * `__screenshots__` and the manifest itself are excluded, and both exclusions
 * are load-bearing: without them writing a baseline — or writing the row about
 * it — would change the digest recorded IN that row, and every row would
 * describe a tree that stopped existing the instant it was written. The
 * manifest half was found by running the reading path against this repository
 * rather than by reasoning about it.
 *
 * **The backend is deliberately OUT**, and it is the interesting omission. A
 * backend change can move pixels — through the data, not the markup — so this
 * set is narrower than "everything that could possibly matter". Including four
 * backend apps would make nearly every commit relevant and the signal would go
 * with it, and the data half already has its own guard: SC-842 asserts the
 * session holds exactly what the fixtures declare before a pixel is captured.
 * If that reasoning is ever shown wrong, this is one constant to widen.
 */
export const RENDERED_PATHS: readonly string[] = [
  'apps/frontend/app',
  'packages/frontend/ui',
  'packages/business/shared',
  'apps/e2e/fixtures',
  'apps/e2e/visual',
  ':(exclude)apps/e2e/visual/__screenshots__',
  ':(exclude)apps/e2e/visual/baselines.provenance.json',
];

/** One `path -> content sha` pair from the working tree, however it was read. */
export interface TreeEntry {
  readonly path: string;
  readonly sha: string;
}

/**
 * How this checkout stands against what it would land onto.
 *
 * Four forms rather than a boolean, because "the remote could not be asked" is
 * not a weaker "unchanged" — it says the question was not answered, and a
 * reader who cannot tell those apart will read the quiet one as the safe one.
 */
export interface BaseClause {
  /** `origin/main` as this checkout has it, or `null` if it could not be read. */
  readonly ref: string | null;
  /** Whether the remote agreed that `ref` is where `main` actually is. */
  readonly confirmed: boolean;
  /** Commits on `origin/main` and not on HEAD, counting only RENDERED_PATHS. */
  readonly behind: number;
}

export interface TreeProvenance {
  /** `HEAD` at capture time, or `null` outside a git checkout. */
  readonly head: string | null;
  /** A digest over the working-tree content of RENDERED_PATHS. */
  readonly renderedDigest: string | null;
  /** Rendered paths differing from HEAD, by name — capped, see `DIRTY_CAP`. */
  readonly dirty: readonly string[];
  /** How many differed in total, which `dirty` may not list all of. */
  readonly dirtyCount: number;
  readonly base: BaseClause;
}

/** One committed baseline's row. */
export interface BaselineRow extends TreeProvenance {
  /** sha256 of the PNG these claims are about. Binds the row to the bytes. */
  readonly sha256: string;
  /** ISO-8601, UTC. `null` on a row that only records the bytes — see `bytesOnlyRow`. */
  readonly capturedAt: string | null;
}

/**
 * The twelve baselines standing when this shipped carry `head: null`.
 *
 * Their trees are genuinely unrecoverable, and **the tempting move is to
 * backfill them with today's HEAD** — which is the exact failure the ticket is
 * about: a field that always reads clean is worse than none, and a row
 * asserting a commit nobody measured looks identical to one that did.
 *
 * So those rows record the one thing that IS known — the bytes — and say
 * UNKNOWN about the rest. That is not decoration: it binds each row to its
 * file, so a hand edit from now on is reportable even on a baseline whose
 * origin was already lost, and each becomes a real row the next time it is
 * regenerated. `unit/baseline-provenance.test.ts` asserts the committed
 * manifest against the committed PNGs, so the claim is checked rather than
 * described.
 */
export interface Manifest {
  readonly baselines: Readonly<Record<string, BaselineRow>>;
}

/**
 * How many dirty paths a row lists before it stops.
 *
 * A row is a review artefact. A refactor touching four hundred files would
 * write four hundred lines into a JSON file somebody has to read in a diff,
 * and the four hundredth name carries no information the count does not.
 */
export const DIRTY_CAP = 12;

export const EMPTY_MANIFEST: Manifest = { baselines: {} };

/**
 * A digest over the rendered tree.
 *
 * Sorted before hashing so the value depends on the content and not on the
 * order git happened to list it in — two readings of one tree that disagreed
 * would make every row incomparable, which is the failure this is for.
 */
export function renderedDigest(entries: readonly TreeEntry[]): string {
  const lines = [...entries]
    .map((entry) => `${entry.path} ${entry.sha}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(lines).digest('hex');
}

/** The tree half of the record, in one sentence. */
export function describeTree(provenance: TreeProvenance): string {
  if (!provenance.head) {
    return 'HEAD UNKNOWN — no commit was recorded for these bytes (they predate SC-833, or this is not a git checkout)';
  }
  const head = provenance.head.slice(0, 9);
  if (provenance.dirtyCount === 0) return `HEAD ${head}, rendered paths clean`;
  const shown = provenance.dirty.slice(0, DIRTY_CAP).join(', ');
  const more =
    provenance.dirtyCount > provenance.dirty.length
      ? `, and ${provenance.dirtyCount - provenance.dirty.length} more`
      : '';
  return `HEAD ${head}, rendered paths DIRTY — ${provenance.dirtyCount} path(s) differ from it: ${shown}${more}`;
}

/**
 * The base half, in one sentence, in the four forms `gate-db`'s verdict uses.
 *
 * `UNCONFIRMED` is not a softer `current`. The local ref is moved by a fetch,
 * and a sibling worktree's fetch moves it without this checkout doing
 * anything — so an unasked remote leaves the reading unanchored rather than
 * merely old.
 */
export function describeBase(base: BaseClause): string {
  if (!base.ref) return 'base UNKNOWN — origin/main could not be read';
  const ref = base.ref.slice(0, 9);
  const suffix = base.confirmed
    ? '(confirmed against the remote)'
    : 'UNCONFIRMED — the remote could not be asked, and a sibling worktree fetch is what moves this ref';
  if (base.behind === 0) return `base ${ref}, no rendered-path commits ahead ${suffix}`;
  return `base ${ref} is ${base.behind} rendered-path commit(s) AHEAD of this tree — these pixels are of a tree main will never have ${suffix}`;
}

/**
 * The block `bun run visual --update` prints, and the one place the two halves
 * are stated together.
 *
 * Returns lines rather than printing, so the shape is assertable without
 * capturing stdout.
 */
export function formatProvenance(written: readonly string[], provenance: TreeProvenance): string[] {
  const lines = [
    `Provenance recorded for ${written.length} baseline(s): ${written.join(', ')}`,
    `  ${describeTree(provenance)}`,
    `  ${describeBase(provenance.base)}`,
    `  rendered digest ${provenance.renderedDigest?.slice(0, 12) ?? 'UNKNOWN'}`,
  ];
  if (provenance.dirtyCount > 0 || provenance.base.behind > 0) {
    lines.push(
      '',
      '  This is a record, not a refusal: a dirty tree is the normal state of a',
      '  regeneration and being behind main does not make a picture wrong, it makes',
      '  it unattributable (SC-833). What it means is that the tree these PNGs are',
      '  pictures of is not one main will ever have — read the rows in the PR beside',
      '  the image diff and decide whether that is what you meant.'
    );
  }
  return lines;
}

/**
 * The rows this run should replace, keyed on the bytes having CHANGED.
 *
 * Not "every baseline the run touched". Under `--update` a screen that already
 * matched is rewritten with identical bytes, and a row rewritten for those
 * would move the recorded commit onto a picture an older tree produced —
 * asserting something no longer measured. A row describes the BYTES, so while
 * the bytes stand the row that came with them stands too.
 */
export function changedBaselines(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>
): string[] {
  return Object.keys(after)
    .filter((name) => before[name] !== after[name])
    .sort();
}

export function mergeManifest(
  existing: Manifest,
  rows: Readonly<Record<string, BaselineRow>>
): Manifest {
  const merged: Record<string, BaselineRow> = { ...existing.baselines, ...rows };
  const ordered: Record<string, BaselineRow> = {};
  for (const name of Object.keys(merged).sort()) ordered[name] = merged[name] as BaselineRow;
  return { baselines: ordered };
}

/**
 * Rows describing bytes that are not on disk, and PNGs no row describes.
 *
 * This is the arm a write-time refusal could not have had. A `--update` run
 * cannot produce either state; a hand edit, a conflict resolution that took
 * the PNG and left the manifest, or a cherry-pick of one without the other
 * all can. `null` when every baseline and every row agree.
 *
 * Reports on BOTH sides on purpose. A row with no PNG is as much a broken
 * claim as a PNG with no row: the second is a picture nothing describes, the
 * first is a description of a picture that is gone.
 */
export function manifestDrift(
  manifest: Manifest,
  onDisk: Readonly<Record<string, string>>
): string | null {
  const rows = Object.keys(manifest.baselines).sort();
  const files = Object.keys(onDisk).sort();

  const unrecorded = files.filter((name) => !(name in manifest.baselines));
  const orphaned = rows.filter((name) => !(name in onDisk));
  const disagreeing = files.filter(
    (name) => name in manifest.baselines && manifest.baselines[name]?.sha256 !== onDisk[name]
  );
  if (unrecorded.length === 0 && orphaned.length === 0 && disagreeing.length === 0) return null;

  const lines = [
    'The committed baselines and their provenance rows disagree, so for these the ' +
      'question "what tree is this a picture of" has no answer (SC-833).',
  ];
  if (disagreeing.length > 0) {
    lines.push(
      `  BYTES DIFFER from the recorded row: ${disagreeing.join(', ')}`,
      '    The PNG on disk is not the one the row describes. Nothing this harness does',
      '    can produce that — a --update run writes both together.'
    );
  }
  if (unrecorded.length > 0) {
    lines.push(`  NO ROW AT ALL: ${unrecorded.join(', ')}`);
  }
  if (orphaned.length > 0) {
    lines.push(`  ROW WITH NO BASELINE: ${orphaned.join(', ')}`);
  }
  lines.push(
    '',
    '  Reported, not failed: the pixels may be perfectly correct and this says nothing',
    '  about them. Re-run `bun run visual --update` from the tree these are meant to be',
    '  pictures of to restate the claim, or fix the rows by hand if you know better.'
  );
  return lines.join('\n');
}

/**
 * One command's output, or `null` if it could not be run or failed.
 *
 * A PORT rather than a `node:child_process` import, and that is what makes the
 * control possible: the unit test hands this a real `git` pointed at a
 * throwaway repository it has deliberately made dirty and deliberately put
 * behind its own `main`, so the reading path — not a stub of it — is the thing
 * under test. A provenance field that can only ever say "clean" is worse than
 * none, and a stub is how one gets written.
 *
 * `null` for a failure of any kind. Every caller below resolves it toward
 * UNKNOWN and never toward clean: `git` missing, a bare directory, a denied
 * remote and a genuinely clean tree must not read alike.
 */
export type Git = (args: readonly string[]) => string | null;

function lines(out: string | null): string[] {
  if (out === null) return [];
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * The rendered tree's content, as git sees it: index blob shas, overlaid with
 * a fresh hash for anything the working tree has changed since, plus untracked
 * files nothing has staged.
 *
 * The overlay is the part that matters. `git ls-files -s` reports the INDEX,
 * so on its own it would report an edited file at its committed sha and a
 * digest computed from it would agree with a tree that stopped existing when
 * somebody saved a file.
 */
function readRenderedEntries(git: Git): TreeEntry[] | null {
  const staged = git(['ls-files', '-s', '--', ...RENDERED_PATHS]);
  if (staged === null) return null;

  const entries = new Map<string, string>();
  for (const line of lines(staged)) {
    // `<mode> <sha> <stage>\t<path>`
    const [meta, path] = line.split('\t');
    const sha = meta?.split(/\s+/)[1];
    if (path && sha) entries.set(path, sha);
  }

  const rehash = [
    ...lines(git(['diff', '--name-only', '--', ...RENDERED_PATHS])),
    ...lines(git(['ls-files', '--others', '--exclude-standard', '--', ...RENDERED_PATHS])),
  ];
  for (const path of new Set(rehash)) {
    const sha = git(['hash-object', '--', path]);
    // A path in the diff with no readable content is a deletion; drop it, which
    // is what the tree now looks like.
    if (sha === null) entries.delete(path);
    else entries.set(path, sha.trim());
  }

  return [...entries].map(([path, sha]) => ({ path, sha }));
}

function readBase(git: Git): BaseClause {
  const ref = git(['rev-parse', 'origin/main']);
  if (ref === null) return { ref: null, confirmed: false, behind: 0 };

  const remote = git(['ls-remote', '--heads', 'origin', 'main']);
  const confirmed = remote?.includes(ref.trim()) ?? false;

  const ahead = git(['rev-list', '--count', 'HEAD..origin/main', '--', ...RENDERED_PATHS]);
  return {
    ref: ref.trim(),
    confirmed,
    behind: ahead === null ? 0 : Number.parseInt(ahead.trim(), 10) || 0,
  };
}

/**
 * Everything the manifest records about the tree, read through `git`.
 *
 * Never throws and never resolves toward clean. Outside a checkout the head is
 * `null` and the digest is `null`, which `describeTree` renders as UNKNOWN —
 * a state a reader can act on, unlike a reassuring blank.
 */
export function readTreeProvenance(git: Git): TreeProvenance {
  const head = git(['rev-parse', 'HEAD']);
  const entries = readRenderedEntries(git);
  const dirty = [
    ...new Set([
      ...lines(git(['diff', '--name-only', 'HEAD', '--', ...RENDERED_PATHS])),
      ...lines(git(['ls-files', '--others', '--exclude-standard', '--', ...RENDERED_PATHS])),
    ]),
  ].sort();

  return {
    head: head === null ? null : head.trim(),
    renderedDigest: entries === null ? null : renderedDigest(entries),
    dirty: dirty.slice(0, DIRTY_CAP),
    dirtyCount: dirty.length,
    base: readBase(git),
  };
}

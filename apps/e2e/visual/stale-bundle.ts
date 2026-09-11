/**
 * Whether the dev frontend may be serving a bundle older than the checkout.
 *
 * The app registers its locales with an eager `import.meta.glob`. Detach the
 * worktree to another commit and back while the frontend container runs, and
 * vite's module graph can keep the locale bundle from the excursion: the dev
 * server serves the current file, the evaluated graph is older. A visual run
 * then photographs a raw i18n key in exactly the row you expected to move, and
 * `--update` commits that as a baseline. Neither `curl` on the locale file nor
 * a sibling key in the same namespace can tell you — both read correct.
 *
 * So the question is asked of git rather than of the page: has HEAD moved to a
 * different commit, other than by committing on top of it, since the container
 * started? A commit does not change the files vite is watching; a checkout,
 * reset, rebase or merge can. This cannot see a `git stash` or a hand edit,
 * which vite's watcher handles anyway.
 */

export interface ReflogEntry {
  /** Seconds since the epoch. */
  readonly at: number;
  readonly sha: string;
  readonly subject: string;
}

/**
 * The reflog format this parses. The time is the ENTRY's, `HEAD@{<epoch>}`
 * under `--date=unix`; `%ct` would be the commit's committer date, which for a
 * checkout back to an old commit is that commit's age, not the moment HEAD moved.
 */
export const REFLOG_ARGS = [
  'reflog',
  '-n',
  '200',
  '--date=unix',
  '--format=%gd%x09%H%x09%gs',
  'HEAD',
];

/** Parses {@link REFLOG_ARGS} output, newest first as git prints it. */
export function parseReflog(text: string): ReflogEntry[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [selector, sha, ...subject] = line.split('\t');
      const at = /@\{(\d+)\}$/.exec(selector ?? '')?.[1];
      return {
        at: at === undefined ? Number.NaN : Number(at),
        sha: sha ?? '',
        subject: subject.join('\t'),
      };
    });
}

const COMMIT_ON_TOP = /^commit( \((amend|initial)\))?:/;

/**
 * The newest HEAD movement after `startedAt` (epoch seconds) that changed the
 * checked-out commit other than by committing, or `null` when there is none.
 * An entry that leaves HEAD on the same commit, like `checkout -b`, is not one.
 */
export function movedSince(entries: readonly ReflogEntry[], startedAt: number): ReflogEntry | null {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as ReflogEntry;
    if (entry.at < startedAt) break;
    if (COMMIT_ON_TOP.test(entry.subject)) continue;
    if (entries[i + 1]?.sha === entry.sha) continue;
    return entry;
  }
  return null;
}

/** `docker inspect`'s `StartedAt` (RFC 3339, nanoseconds) as epoch seconds, or `null`. */
export function parseStartedAt(value: string): number | null {
  const ms = Date.parse(value.trim().replace(/(\.\d{3})\d+/, '$1'));
  return Number.isNaN(ms) || ms <= 0 ? null : Math.floor(ms / 1000);
}

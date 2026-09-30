import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyDockerProbe, type DockerProbe, probeWithRetry } from './port-holder';
import { composeProjectName } from './worktree';

/**
 * The prefix `composeProjectName` gives every checkout's project. Projects
 * outside it belong to another product on this machine (`ab-test*`,
 * `buildx_buildkit_*`) and are none of this repository's business — naming one
 * as an orphan would be a claim about somebody else's work.
 *
 * Pinned against `composeProjectName` by a test rather than by comment, so
 * renaming the derivation cannot silently empty this census.
 */
export const PROJECT_PREFIX = 'scani';

/**
 * A project name that some checkout's derivation produced: `<prefix>_<label>_
 * <8 hex>`, per `worktreeSuffix`. Load-bearing in exactly one place — it is
 * what separates a name that IS a derivation nobody live produces (gone) from
 * a name that is not a derivation at all (unattributed).
 */
const DERIVED_SHAPE = new RegExp(`^${PROJECT_PREFIX}_.+_[0-9a-f]{8}$`);

/** Whether a name is one `composeProjectName` produces. */
export function isDerivedName(project: string): boolean {
  return DERIVED_SHAPE.test(project);
}

/** In scope for this census: the bare default project, or a derived one. */
export function inScope(project: string): boolean {
  return project === PROJECT_PREFIX || project.startsWith(`${PROJECT_PREFIX}_`);
}

export interface CensusContainer {
  name: string;
  project: string;
  /** `com.docker.compose.project.working_dir`, or `''` when absent. */
  workingDir: string;
  running: boolean;
}

export interface CensusVolume {
  name: string;
  project: string;
  /** `null` from the cheap probe, which does not carry sizes. */
  sizeBytes: number | null;
}

/**
 * The five answers this census can give.
 *
 * `live-idle` MUST NOT fold into either `gone-*`. A checkout whose stack is
 * merely down is not reclaimable — somebody may return to it tomorrow — and
 * conflating the two is how a reporter becomes a reaper in a reader's head.
 * `isReclaimable` below is the mechanical form of that rule, so it is enforced
 * rather than remembered.
 */
export type StackState =
  | 'gone-running'
  | 'gone-idle'
  | 'live-running'
  | 'live-idle'
  | 'unattributed';

export interface StackProject {
  project: string;
  state: StackState;
  /** From a container label when one exists, else `null` (volumes carry none). */
  workingDir: string | null;
  containers: readonly CensusContainer[];
  volumes: readonly CensusVolume[];
  /** Summed volume bytes, or `null` when any volume's size is unknown. */
  bytes: number | null;
}

/**
 * The only place a state becomes a claim about what may be removed.
 *
 * `unattributed` is false for the same reason `foreignHolder` returns `null`
 * on an unlabelled container: cannot tell is not the same as nobody needs it,
 * and resolving it toward the destructive answer is the one direction with no
 * recovery.
 */
export function isReclaimable(state: StackState): boolean {
  return state === 'gone-running' || state === 'gone-idle';
}

const SIZE_UNITS: Readonly<Record<string, number>> = {
  B: 1,
  kB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
  PB: 1e15,
};

/**
 * `docker system df` prints sizes through go-units, which is base 1000 and
 * writes `266B`, `65.2MB`, `1.73GB`. Unparseable is `null`, never 0: a size
 * this cannot read must not make a 1.7 GB volume report as weightless.
 */
export function parseHumanSize(text: string): number | null {
  const match = /^([\d.]+)\s*([kMGTP]?B)$/.exec(text.trim());
  if (!match) return null;
  const multiplier = SIZE_UNITS[match[2] as string];
  const value = Number(match[1]);
  if (multiplier === undefined || !Number.isFinite(value)) return null;
  return value * multiplier;
}

/** The inverse, for display only. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'size unknown';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)}${units[unit]}`;
}

/** The field order `probeContainers` asks for, and this parser reads. */
const DOCKER_PS_FORMAT =
  '{{.Names}}\t{{.Label "com.docker.compose.project"}}\t' +
  '{{.Label "com.docker.compose.project.working_dir"}}\t{{.State}}';

export function parseComposeContainers(output: string): CensusContainer[] {
  const containers: CensusContainer[] = [];
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue;
    const [name = '', project = '', workingDir = '', state = ''] = line.split('\t');
    if (project === '') continue;
    containers.push({ name, project, workingDir, running: state === 'running' });
  }
  return containers;
}

/** The field order `probeVolumes` asks for, and this parser reads. */
const DOCKER_VOLUME_FORMAT = '{{.Name}}\t{{.Label "com.docker.compose.project"}}';

/** The cheap probe (~0.13s): names and projects, no sizes. */
export function parseVolumeList(output: string): CensusVolume[] {
  const volumes: CensusVolume[] = [];
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue;
    const [name = '', project = ''] = line.split('\t');
    if (project === '') continue;
    volumes.push({ name, project, sizeBytes: null });
  }
  return volumes;
}

/**
 * The full probe (~4s): `docker system df -v --format '{{json .Volumes}}'`.
 *
 * Sizes are what make the report actionable — one `workspace-node-modules`
 * volume measured 1.73 GB against 65 MB for a Postgres — so the report pays
 * the four seconds and the `down` clause does not.
 *
 * `Labels` arrives as one comma-joined `k=v` string rather than an object,
 * which is why this cannot share a parser with the `--format` probe above.
 */
export function parseVolumeSizes(json: string): CensusVolume[] {
  let rows: unknown;
  try {
    rows = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];

  const volumes: CensusVolume[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const record = row as Record<string, unknown>;
    const name = typeof record.Name === 'string' ? record.Name : '';
    const labels = typeof record.Labels === 'string' ? record.Labels : '';
    const project =
      labels
        .split(',')
        .map((pair) => pair.split('='))
        .find(([key]) => key === 'com.docker.compose.project')?.[1] ?? '';
    if (name === '' || project === '') continue;
    volumes.push({
      name,
      project,
      sizeBytes: typeof record.Size === 'string' ? parseHumanSize(record.Size) : null,
    });
  }
  return volumes;
}

export interface CensusInput {
  containers: readonly CensusContainer[];
  volumes: readonly CensusVolume[];
  /**
   * The project name every live checkout produces, or `null` when git could
   * not be asked.
   *
   * `null` is NOT an empty set and is never resolved toward one. An empty set
   * would make every project on the machine read as behind no checkout, which
   * is the maximally destructive reading of a question that was never
   * answered — so `null` sends everything to `unattributed` instead.
   */
  liveProjects: ReadonlySet<string> | null;
}

export function censusProjects(input: CensusInput): StackProject[] {
  const names = new Set<string>();
  for (const c of input.containers) if (inScope(c.project)) names.add(c.project);
  for (const v of input.volumes) if (inScope(v.project)) names.add(v.project);

  const projects: StackProject[] = [];
  for (const project of [...names].sort()) {
    const containers = input.containers.filter((c) => c.project === project);
    const volumes = input.volumes.filter((v) => v.project === project);

    // Direct positive evidence beats the derivation, and it is what makes this
    // correct for a checkout this repository's `git worktree list` cannot see
    // — a second clone, or a self-hoster's copy elsewhere on the disk.
    const labelled = containers.find((c) => c.workingDir !== '');
    const workingDir = labelled?.workingDir ?? null;
    const attestedLive = containers.some((c) => c.workingDir !== '' && existsSync(c.workingDir));
    // Death needs a POSITIVE reading too (SC-1417): a labelled container whose
    // checkout is confirmed absent. Volumes carry no working_dir, and missing
    // from this repository's worktree list only means "not a checkout we can
    // see". That read offered the live scani-oss clone's volumes for --apply.
    const attestedGone =
      !attestedLive &&
      containers.some((c) => c.workingDir !== '') &&
      containers.every((c) => c.workingDir === '' || pathPresence(c.workingDir) === 'absent');

    const derivedLive = input.liveProjects?.has(project) ?? false;
    const running = containers.some((c) => c.running);

    let state: StackState;
    if (attestedLive || derivedLive) {
      state = running ? 'live-running' : 'live-idle';
    } else if (input.liveProjects !== null && DERIVED_SHAPE.test(project) && attestedGone) {
      state = running ? 'gone-running' : 'gone-idle';
    } else {
      state = 'unattributed';
    }

    const sizes = volumes.map((v) => v.sizeBytes);
    projects.push({
      project,
      state,
      workingDir,
      containers,
      volumes,
      bytes: sizes.some((s) => s === null)
        ? null
        : sizes.reduce<number>((total, size) => total + (size ?? 0), 0),
    });
  }
  return projects;
}

/**
 * How the set of live checkouts was arrived at, as opposed to what it contains
 * (SC-803).
 *
 * The census only ever needed the SET, and folded the three ways of getting one
 * into `Set | null`. That is correct for a reporter, whose reader is told the
 * count and warned to check it. It is not enough for anything that ACTS on the
 * answer, because two of the three are not measurements:
 *
 *   enumerated  git listed the worktrees. The only answer that is evidence.
 *   assumed     git could not be asked, so this checkout is taken to be the
 *               only one. Ordinary for a self-hoster with a source tarball,
 *               and indistinguishable from `enumerated` with one worktree once
 *               the set is all you keep.
 *   unreadable  git answered with a shape this cannot parse.
 *
 * `assumed` is the dangerous one and the reason this distinction exists. Every
 * project on the machine that is not THIS checkout's then falls outside the
 * live set, so on a box with seven worktrees a failed `git` call makes six live
 * stacks — the primary checkout's among them — read as behind no checkout. A
 * reporter prints that under a heading telling the reader to check it. A reaper
 * acting on it deletes somebody's database, so `stack-reaper.ts` requires
 * `enumerated` and refuses the other two.
 */
export type CheckoutEnumeration =
  | { readonly kind: 'enumerated'; readonly projects: ReadonlySet<string> }
  | { readonly kind: 'assumed'; readonly projects: ReadonlySet<string> }
  | { readonly kind: 'unreadable' };

/** The set to judge against, or `null` — see `CensusInput.liveProjects`. */
function enumeratedProjects(e: CheckoutEnumeration): ReadonlySet<string> | null {
  return e.kind === 'unreadable' ? null : e.projects;
}

/**
 * Every checkout of this repository, as compose project names, with how the
 * answer was reached.
 */
function liveCheckoutProjects(repoRoot: string): CheckoutEnumeration {
  const probe = spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 10_000,
  });

  // A tarball or a non-repository answers nothing, and then this checkout is
  // the only one there is. Not `unreadable`: that is a settled answer rather
  // than an unasked question, and it is the ordinary case for a self-hoster.
  if (probe.status !== 0 || typeof probe.stdout !== 'string') {
    return { kind: 'assumed', projects: new Set([composeProjectName(resolve(repoRoot))]) };
  }

  const projects = new Set<string>();
  for (const line of probe.stdout.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    projects.add(composeProjectName(resolve(line.slice('worktree '.length).trim())));
  }
  // `git worktree list` always lists at least the main working tree, so an
  // empty result means the output shape changed under us rather than that no
  // checkout exists.
  return projects.size === 0 ? { kind: 'unreadable' } : { kind: 'enumerated', projects };
}

function probe(argv: readonly string[]): DockerProbe {
  return probeWithRetry((timeout) =>
    classifyDockerProbe(spawnSync(argv[0] as string, argv.slice(1), { encoding: 'utf8', timeout }))
  );
}

export interface MachineCensus {
  projects: StackProject[];
  /** Why docker could not be asked, or `null` when it answered. */
  blind: DockerProbe | null;
  /**
   * The size probe that was asked for and did not answer, or `null`. Sizes
   * then read `size unknown`; nothing else about the census changes.
   */
  sizesUnmeasured: DockerProbe | null;
  /**
   * How many checkouts the attribution was judged against, or `null` when git
   * could not be asked.
   *
   * PRINTED, because it is the census's one assumption and a reader cannot
   * check an assumption they are not told. Measured 2026-08-27: run from a
   * SEPARATE clone of this repository, the census called six projects
   * unattributed-to-a-checkout when five had live worktrees — including the
   * primary checkout's own stack — because `git worktree list` in that clone
   * reports only itself. Volume-only projects carry no `working_dir` to
   * rescue them, which is the same gap that forces the inversion.
   *
   * It is exact in both real configurations: one clone with N worktrees (this
   * machine) enumerates all N, and a self-hoster's single clone enumerates the
   * only checkout there is. It degrades only with two INDEPENDENT clones on
   * one machine, and then it degrades toward calling somebody's live stack
   * reclaimable — so the number goes on the report rather than in a comment.
   */
  checkouts: number | null;
  /**
   * HOW that number was reached, for a consumer that ACTS on it (SC-803).
   *
   * The count alone cannot separate `enumerated` with one worktree from
   * `assumed` after a failed `git` call — see `CheckoutEnumeration`. The report
   * does not need the difference because it prints a warning either way; a
   * reaper does, because `assumed` on this machine would make six live stacks
   * read as reclaimable.
   *
   * `null` when docker was blind, so nothing was enumerated at all.
   */
  enumeration: CheckoutEnumeration | null;
}

/**
 * Ask this machine. `withSizes` adds the `docker system df -v` probe; the
 * cheap path is ~0.13s and is what the `down` clause uses.
 */
export function censusFromMachine(repoRoot: string, withSizes: boolean): MachineCensus {
  const ps = probe(['docker', 'ps', '-a', '--no-trunc', '--format', DOCKER_PS_FORMAT]);
  if (ps.kind !== 'ok') return blindCensus(ps);
  return censusFromProbes(
    {
      ps,
      volumes: probe(['docker', 'volume', 'ls', '--format', DOCKER_VOLUME_FORMAT]),
      sizes: withSizes
        ? probe(['docker', 'system', 'df', '-v', '--format', '{{json .Volumes}}'])
        : null,
    },
    () => liveCheckoutProjects(repoRoot)
  );
}

interface CensusProbes {
  ps: DockerProbe;
  volumes: DockerProbe;
  /** `null` when sizes were not asked for. */
  sizes: DockerProbe | null;
}

/**
 * The census from what docker answered.
 *
 * THE VOLUME LIST IS REQUIRED AND ITS SIZES ARE NOT (SC-1417). `docker system
 * df -v` walks every volume and got slower as dead ones piled up: 12s on 71
 * volumes standalone, and a timeout on both attempts inside the census. When it
 * alone was the volume source, that made the whole census blind, so the reaper
 * refused to reclaim the very pile that was slowing it down. Sizes now come
 * from it only as an overlay on the cheap list, and a size probe that did not
 * answer leaves sizes unknown, reported in `sizesUnmeasured`, never blindness.
 */
export function censusFromProbes(
  probes: CensusProbes,
  enumerate: () => CheckoutEnumeration
): MachineCensus {
  if (probes.ps.kind !== 'ok') return blindCensus(probes.ps);
  if (probes.volumes.kind !== 'ok') return blindCensus(probes.volumes);

  const sized =
    probes.sizes?.kind === 'ok'
      ? new Map(parseVolumeSizes(probes.sizes.output).map((v) => [v.name, v.sizeBytes]))
      : null;
  const volumes = parseVolumeList(probes.volumes.output).map((v) => ({
    ...v,
    sizeBytes: sized?.get(v.name) ?? null,
  }));

  const enumeration = enumerate();
  const liveProjects = enumeratedProjects(enumeration);
  return {
    projects: censusProjects({
      containers: parseComposeContainers(probes.ps.output),
      volumes,
      liveProjects,
    }),
    blind: null,
    sizesUnmeasured: probes.sizes && probes.sizes.kind !== 'ok' ? probes.sizes : null,
    checkouts: liveProjects?.size ?? null,
    enumeration,
  };
}

function blindCensus(blind: DockerProbe): MachineCensus {
  return { projects: [], blind, sizesUnmeasured: null, checkouts: null, enumeration: null };
}

/**
 * The clause `dev:stack down` appends to its own verdict, or `null`.
 *
 * SILENT ON ZERO. A line that prints on every teardown becomes furniture, and
 * `down` is the hottest path in this repo — every worker runs it at the end of
 * every gate.
 *
 * IT NAMES THE REAPER AS WELL AS THE REPORTER (SC-803). This clause is the one
 * place a person meets an orphan on a path they were already walking, and until
 * there was something to DO about it, that was all it could be: reclaiming a
 * stack whose worktree is gone needed a `docker compose -p <derived project>`
 * incantation that is nowhere in this repository's documented commands. A
 * notice whose only remedy is a command nobody knows produces the count that
 * went from six to twenty-one in a week.
 *
 * SILENT WHEN DOCKER IS BLIND, which is not a false clean: `down` derives
 * `remainingContainers` from the same daemon, so a blind census means `down`
 * has already printed `DOWN UNVERIFIED · docker could not be asked`. The
 * reader is told, once, by the check whose job it is. `bun run dev:stacks`
 * reports the blindness in full.
 */
export function orphanClause(projects: readonly StackProject[], ownProject: string): string | null {
  const orphans = projects.filter((p) => p.project !== ownProject && isReclaimable(p.state));
  if (orphans.length === 0) return null;
  return (
    `dev-stack: ${orphans.length} other compose project(s) on this machine have no ` +
    'checkout behind them — `bun run dev:stacks` to see them, ' +
    '`bun run dev:stacks:reap` to reclaim them (dry run by default)'
  );
}

const HEADINGS: Readonly<Record<StackState, string>> = {
  'gone-running':
    'NO CHECKOUT OF THIS REPOSITORY · containers running — holding CPU, ports and disk',
  'gone-idle': 'NO CHECKOUT OF THIS REPOSITORY · volumes only — holding disk',
  'live-running': 'live checkout · stack running',
  'live-idle': 'live checkout · stack down — NOT reclaimable, someone may return to it',
  unattributed: 'CANNOT ATTRIBUTE — never assume reclaimable',
};

const ORDER: readonly StackState[] = [
  'gone-running',
  'gone-idle',
  'unattributed',
  'live-idle',
  'live-running',
];

function describeProject(p: StackProject): string {
  const running = p.containers.filter((c) => c.running).length;
  const parts = [
    `${p.containers.length} container(s), ${running} running`,
    `${p.volumes.length} volume(s) ${formatBytes(p.bytes)}`,
  ];
  const where =
    p.workingDir === null
      ? 'no working_dir label — volumes carry none'
      : `${p.workingDir}${pathSuffix(p.workingDir)}`;
  return `  ${p.project}\n    ${parts.join(' · ')}\n    ${where}`;
}

/**
 * `existsSync` answers `false` both when a directory is gone and when it could
 * not be read, so a read denial rendered ` — gone` about a directory that is
 * there (SC-973). Only ENOENT and ENOTDIR say it is absent; any other errno is
 * a look that failed. The verdict reads this too since SC-1417, where a failed
 * look can only keep a project out of `gone-*`.
 */
function pathPresence(dir: string): 'present' | 'absent' | { unknown: string } {
  try {
    statSync(dir);
    return 'present';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : { unknown: code };
  }
}

export function pathSuffix(dir: string): string {
  const presence = pathPresence(dir);
  if (presence === 'present') return '';
  if (presence === 'absent') return ' — gone';
  return ` — could not look (${presence.unknown}), which is not a claim it is gone`;
}

/**
 * The report. Groups by state and never prints a single total, because the one
 * number a reader would take from it is the one that must not exist: idle and
 * orphaned summed together is a reap list.
 */
/**
 * Why every size reads `size unknown`, or `null` when they were measured or
 * never asked for. Printed rather than left to the per-project text, which
 * cannot tell "docker did not say" from "docker was not asked".
 */
export function sizesClause(census: MachineCensus): string | null {
  const probe = census.sizesUnmeasured;
  if (probe === null) return null;
  const why =
    probe.kind === 'timedOut'
      ? 'did not answer in time'
      : probe.kind === 'unavailable'
        ? `failed: ${probe.reason}`
        : 'answered';
  return (
    `sizes were not measured: \`docker system df -v\` ${why}. The volume list ` +
    'came from `docker volume ls` and is complete; only the sizes are unknown (SC-1417).'
  );
}

export function formatCensus(census: MachineCensus): string {
  if (census.blind !== null) {
    return `stacks: docker could not be asked — ${describeBlind(census.blind)}\n`;
  }
  if (census.projects.length === 0) {
    return `stacks: no ${PROJECT_PREFIX} compose project on this machine\n`;
  }

  const lines: string[] = [];
  for (const state of ORDER) {
    const group = census.projects.filter((p) => p.state === state);
    if (group.length === 0) continue;
    lines.push(`${HEADINGS[state]} (${group.length})`);
    for (const p of group) lines.push(describeProject(p));
    lines.push('');
  }
  const sizes = sizesClause(census);
  if (sizes !== null) lines.push(sizes);
  lines.push(
    `Attributed against the ${census.checkouts ?? 'unknown number of'} checkout(s) ` +
      "`git worktree list` reports for THIS repository. A separate clone's stack " +
      'reads as having no checkout — check before believing it about a volume-only ' +
      'project, which carries no working_dir to judge by.'
  );
  lines.push(
    'Nothing was stopped or removed. Whether any of these may be reclaimed is not ' +
      "this command's call (SC-530)."
  );
  return `${lines.join('\n')}\n`;
}

function describeBlind(p: DockerProbe): string {
  if (p.kind === 'timedOut')
    return 'it did not answer, twice — the box is loaded, not that there is no answer';
  if (p.kind === 'unavailable') return p.reason;
  return 'docker answered';
}

/**
 * What a path-filtered CI job READS, and whether the filter that gates it can
 * see every one of those files (SC-1161).
 *
 * A paths-filter is a list somebody wrote once. A file the job consumes that
 * the list does not name produces a `skipped` job, and `CI Success` reads that
 * word as a pass. SC-1156 was one instance: `docker-compose.yml` matched no
 * filter, so the pull request repairing the compose stack could not trigger
 * the E2E job whose first step is `docker compose up`. Adding that one pattern
 * fixed the instance; this module is the class.
 *
 * TWO DERIVATIONS, BOTH FROM THE WORKFLOW RATHER THAN FROM A LIST HERE:
 *
 *   inputs    every `run:` command a gated job executes is resolved to the
 *             files it consumes — package scripts recursively, `bun test`
 *             roots and preloads, tool configs, compose-built Dockerfiles and
 *             their COPY sources, `cp` sources, local composite actions. A
 *             command no resolver recognises is returned in `unresolved`, so a
 *             NEW STEP cannot quietly add an input nobody derived.
 *   filters   `dorny/paths-filter` outputs a job's `if:` reads, or the
 *             `on.<event>.paths` of the workflow it sits in.
 *
 * A TREE IS AN INPUT AS A WHOLE. `bun test scripts/` consumes whatever file a
 * test under `scripts/` opens, so every tracked file under it must reach the
 * job. That is what catches the recurring shape — a new FILE TYPE under a
 * directory the filter enumerates by extension.
 *
 * PURE: every function takes the tracked file list and the file contents it
 * needs through `RepoView`, and reads nothing itself, so a test can hand it a
 * fixture tree (SC-1193 reuses this to pick the suites a change touches).
 *
 * WHAT IT CANNOT SEE: a file a script opens by a path computed at runtime.
 * `bun scripts/check-docs.ts` is resolved to the script and its import graph,
 * not to the markdown it globs. Those reads are declared in `SCRIPT_READS`
 * beside the script they belong to, and that table is the one hand-kept part.
 */

export interface RepoView {
  /** Every tracked path, repository-relative. */
  readonly files: readonly string[];
  /** Contents of a tracked file, or null when it is not in the tree. */
  read(path: string): string | null;
}

export interface WorkflowFile {
  readonly path: string;
  readonly text: string;
}

export interface GatedJob {
  readonly workflow: string;
  readonly jobId: string;
  readonly name: string;
  /** How the job is gated, and the globs that can make it run. */
  readonly gate: { kind: 'paths-filter'; outputs: string[] } | { kind: 'on-paths'; event: string };
  readonly globs: readonly string[];
}

interface ImageBuild {
  readonly dockerfile: string;
  /** `--target` / `build.target`; null builds the final stage. */
  readonly target: string | null;
  readonly context: string;
  /** What this build's COPY/ADD lines take from the context. */
  readonly files: readonly string[];
  readonly trees: readonly string[];
}

export interface JobInputs {
  /** Individual files the job consumes. */
  readonly files: readonly string[];
  /** Directory prefixes (trailing `/`) the job consumes wholesale; `''` is the whole checkout. */
  readonly trees: readonly string[];
  /** Every image the job builds, so one job's cover of another can be proven. */
  readonly builds: readonly ImageBuild[];
  /** Commands no resolver recognised — each one an input nobody derived. */
  readonly unresolved: readonly string[];
}

type Step = {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  'working-directory'?: string;
};
type Job = {
  name?: string;
  if?: string;
  steps?: Step[];
  outputs?: Record<string, string>;
  strategy?: { matrix?: Record<string, unknown> };
};
type Workflow = { on?: unknown; jobs?: Record<string, Job> };

function parseWorkflow(text: string): Workflow {
  const parsed = Bun.YAML.parse(text) as Workflow & { true?: unknown };
  // YAML 1.1 reads a bare `on:` key as boolean true.
  if (parsed.on === undefined && parsed.true !== undefined) parsed.on = parsed.true;
  return parsed;
}

/** `dorny/paths-filter` semantics: picomatch with `dot: true`. */
function globMatches(glob: string, path: string): boolean {
  return new Bun.Glob(glob).match(path);
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

export function gatedJobs(workflows: readonly WorkflowFile[]): GatedJob[] {
  const out: GatedJob[] = [];
  for (const file of workflows) {
    const wf = parseWorkflow(file.text);
    const jobs = Object.entries(wf.jobs ?? {});

    const filterJob = jobs.find(([, j]) =>
      (j.steps ?? []).some((s) => (s.uses ?? '').includes('dorny/paths-filter'))
    );
    if (filterJob) {
      const [filterId, fj] = filterJob;
      const step = (fj.steps ?? []).find((s) => (s.uses ?? '').includes('dorny/paths-filter'));
      const filters = Bun.YAML.parse(String(step?.with?.filters ?? '')) as Record<string, string[]>;
      const outputMap: Record<string, string> = {};
      for (const [name, expr] of Object.entries(fj.outputs ?? {})) {
        outputMap[name] = /steps\.[\w-]+\.outputs\.([\w-]+)/.exec(String(expr))?.[1] ?? name;
      }
      for (const [jobId, job] of jobs) {
        if (jobId === filterId) continue;
        const outputs = [
          ...String(job.if ?? '').matchAll(
            new RegExp(`needs\\.${filterId}\\.outputs\\.([\\w-]+)`, 'g')
          ),
        ].map((m) => m[1] as string);
        if (outputs.length === 0) continue;
        out.push({
          workflow: file.path,
          jobId,
          name: job.name ?? jobId,
          gate: { kind: 'paths-filter', outputs },
          globs: outputs.flatMap((o) => filters[outputMap[o] ?? o] ?? []),
        });
      }
    }

    const on = (wf.on ?? {}) as Record<string, { paths?: string[] } | null>;
    if (typeof on !== 'object') continue;
    for (const [event, spec] of Object.entries(on)) {
      const paths = spec?.paths;
      if (!paths) continue;
      for (const [jobId, job] of jobs) {
        out.push({
          workflow: file.path,
          jobId,
          name: job.name ?? jobId,
          gate: { kind: 'on-paths', event },
          globs: paths,
        });
      }
    }
  }
  return out;
}

/** Every gate a changed path opens — the question SC-1193 asks the other way round. */
export function filtersMatching(
  path: string,
  workflows: readonly WorkflowFile[]
): { workflow: string; jobId: string; gate: GatedJob['gate'] }[] {
  return gatedJobs(workflows)
    .filter((job) => job.globs.some((g) => globMatches(g, path)))
    .map(({ workflow, jobId, gate }) => ({ workflow, jobId, gate }));
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Files a script opens by a path it computes, which an import graph cannot
 * see. Keep each entry beside a reason; an entry is a claim about the script.
 */
const SCRIPT_READS: Record<
  string,
  { trees?: string[]; globs?: string[]; composeUp?: boolean; why: string }
> = {
  'scripts/dev-stack.ts': {
    composeUp: true,
    why: '`up` runs `docker compose --profile full up -d --build` (`upArgs`), so it builds every compose service image',
  },
  'scripts/check-docs.ts': {
    globs: ['**/*.md', '**/*.mdx', '.env.example'],
    why: 'reads every tracked markdown file for placement, compiles every .mdx page, and diffs .env.example against the env schemas',
  },
  'scripts/generate-ci-filters.ts': {
    globs: ['packages/*/*/package.json', '.github/workflows/ci.yml'],
    why: 'regenerates the per-package filter block from the workspace list',
  },
  'scripts/sync-dockerhub-readme.ts': {
    trees: ['docker-readmes/'],
    why: 'validates every Docker Hub description',
  },
  'scripts/check-migration-drift-declared.ts': {
    trees: ['packages/infra/db/src/migrations/'],
    why: 'hashes every migration against the base',
  },
  'scripts/migrate.ts': {
    trees: ['packages/infra/db/src/migrations/'],
    why: 'applies the migration directory',
  },
};

/** What `bun` reads on every invocation. */
const BUN_CONFIG = 'bunfig.toml';

/** What `bun install` reads: the manifests, the lockfile and the patches it applies. */
function addInstall(ctx: Ctx): void {
  for (const f of ['package.json', 'bun.lock', BUN_CONFIG]) addPath(ctx, f);
  addPath(ctx, 'patches/');
  for (const ws of workspaces(ctx)) ctx.files.add(`${ws}/package.json`);
}

/** Commands that consume nothing from the tree. */
const NO_INPUT = [
  /^#/,
  /^\{$/,
  /^\}/,
  /^until\b/,
  /^echo\b/,
  /^set\b/,
  /^true$/,
  /^exit\b/,
  /^fi$/,
  /^then$/,
  /^else$/,
  /^if\b/,
  /^elapsed\b/,
  /^bunx playwright install\b/,
  /^docker compose .*\b(logs|down|ps)\b/,
  /^docker (network|run|rm|stop|logs|exec)\b/,
  /^cat\b/,
  /^test\b/,
  /^\[/,
  /^\{?\s*\w+=/,
  /^curl\b/,
  /^sleep\b/,
  /^for\b|^done$|^do\b/,
];

interface Ctx {
  repo: RepoView;
  cwd: string;
  seen: Set<string>;
  files: Set<string>;
  trees: Set<string>;
  builds: ImageBuild[];
  unresolved: string[];
}

function norm(cwd: string, p: string): string {
  const parts = `${cwd ? `${cwd}/` : ''}${p.replace(/^\.\//, '')}`.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function addPath(ctx: Ctx, path: string): void {
  if (path === '') {
    ctx.trees.add(''); // the whole checkout, e.g. `COPY . .`
    return;
  }
  if (ctx.repo.read(path) !== null) {
    ctx.files.add(path);
    return;
  }
  const tree = path.endsWith('/') ? path : `${path}/`;
  if (ctx.repo.files.some((f) => f.startsWith(tree))) ctx.trees.add(tree);
}

function addGlob(ctx: Ctx, glob: string): void {
  for (const f of ctx.repo.files) if (globMatches(glob, f)) ctx.files.add(f);
}

/** The script, its local import graph, and whatever `SCRIPT_READS` declares for it. */
function addScript(ctx: Ctx, path: string): void {
  if (ctx.seen.has(path)) return;
  ctx.seen.add(path);
  const text = ctx.repo.read(path);
  if (text === null) return;
  ctx.files.add(path);
  const declared = SCRIPT_READS[path];
  for (const t of declared?.trees ?? []) addPath(ctx, t);
  for (const g of declared?.globs ?? []) addGlob(ctx, g);
  if (declared?.composeUp) addCompose(ctx);
  if (!/\.(ts|tsx|js|mjs|cjs)$/.test(path)) return;
  let imports: { path: string }[] = [];
  try {
    // The transpiler refuses a shebang, and most entry scripts here start with one.
    imports = new Bun.Transpiler({ loader: path.endsWith('x') ? 'tsx' : 'ts' }).scanImports(
      text.replace(/^#!.*/, '')
    );
  } catch {
    ctx.unresolved.push(`import graph unreadable: ${path}`);
    return;
  }
  const dir = path.split('/').slice(0, -1).join('/');
  for (const { path: spec } of imports) {
    if (!spec.startsWith('.')) continue;
    const base = norm(dir, spec);
    const hit = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(
      (c) => ctx.repo.read(c) !== null
    );
    if (hit) addScript(ctx, hit);
  }
}

function packageScripts(ctx: Ctx, dir: string): Record<string, string> {
  const text = ctx.repo.read(norm(dir, 'package.json'));
  if (text === null) return {};
  return (JSON.parse(text) as { scripts?: Record<string, string> }).scripts ?? {};
}

function workspaces(ctx: Ctx): string[] {
  return ctx.repo.files
    .filter((f) => /^(apps|packages)\/[^/]+\/[^/]+\/package\.json$/.test(f))
    .map((f) => f.slice(0, -'/package.json'.length));
}

/** The nearest directory above `path` holding a package.json. */
function workspaceOf(ctx: Ctx, path: string): string {
  const parts = path.split('/').slice(0, -1);
  while (parts.length > 0) {
    const dir = parts.join('/');
    if (ctx.repo.read(`${dir}/package.json`) !== null) return dir;
    parts.pop();
  }
  return '';
}

/** The Dockerfile, and what its COPY/ADD lines take from the build context. */
function addDockerfile(ctx: Ctx, dockerfile: string, context: string, target: string | null): void {
  const text = ctx.repo.read(dockerfile);
  if (text === null) {
    ctx.unresolved.push(`dockerfile not in tree: ${dockerfile}`);
    return;
  }
  // Collected into a scratch context first, so the build can report exactly
  // what it took — the proof an exemption leans on.
  const own: Ctx = { ...ctx, files: new Set(), trees: new Set(), builds: [] };
  buildInputs(own, text, dockerfile, context);
  ctx.builds.push({
    dockerfile,
    target,
    context,
    files: [...own.files].sort(),
    trees: [...own.trees].sort(),
  });
  for (const f of own.files) ctx.files.add(f);
  for (const t of own.trees) ctx.trees.add(t);
}

function buildInputs(ctx: Ctx, text: string, dockerfile: string, context: string): void {
  ctx.files.add(dockerfile);
  addPath(ctx, norm(context, '.dockerignore'));
  for (const line of text.split('\n')) {
    const m = /^\s*(COPY|ADD)\s+(.*)$/i.exec(line);
    if (!m) continue;
    const args = (m[2] as string).split(/\s+/).filter((a) => !a.startsWith('--'));
    if ((m[2] as string).includes('--from=')) continue;
    for (const src of args.slice(0, -1)) {
      if (src === '.' && context === '') {
        // The whole checkout copied in to build one workspace: what the build
        // consumes is that workspace and the packages it imports — the same
        // rule a dev server bind-mounting the checkout gets in `addCompose`.
        addPath(ctx, workspaceOf(ctx, dockerfile));
        addPath(ctx, 'packages/');
      } else if (src === '.') addPath(ctx, context);
      else if (src.includes('*')) addGlob(ctx, norm(context, src));
      else addPath(ctx, norm(context, src));
    }
  }
}

/** `docker compose` as `bun dev:stack` runs it: every service it builds or bind-mounts. */
function addCompose(ctx: Ctx): void {
  for (const compose of ctx.repo.files.filter((f) => /^docker-compose[^/]*\.ya?ml$/.test(f))) {
    ctx.files.add(compose);
  }
  const text = ctx.repo.read('docker-compose.yml');
  if (text === null) return;
  const doc = Bun.YAML.parse(text) as {
    services?: Record<
      string,
      {
        build?: { context?: string; dockerfile?: string; target?: string };
        volumes?: string[];
        working_dir?: string;
      }
    >;
  };
  for (const service of Object.values(doc.services ?? {})) {
    if (service.build) {
      const context = norm('', service.build.context ?? '.');
      addDockerfile(
        ctx,
        norm(context, service.build.dockerfile ?? 'Dockerfile'),
        context,
        service.build.target ?? null
      );
    }
    for (const volume of service.volumes ?? []) {
      const source = volume.split(':')[0] as string;
      if (!source.startsWith('.')) continue; // a named volume
      const mounted = norm('', source);
      if (mounted !== '') {
        addPath(ctx, mounted);
        continue;
      }
      // The whole checkout mounted into a dev server: what it serves is its
      // own workspace and the packages it imports, not every file in the repo.
      const wd = /^\/app\/?(.*)$/.exec(service.working_dir ?? '')?.[1];
      if (wd) addPath(ctx, wd);
      addPath(ctx, 'packages/');
    }
  }
}

function addCommand(ctx: Ctx, raw: string): void {
  const cmd = raw.trim().replace(/\s+#.*$/, '');
  if (cmd === '') return;

  const chained = cmd.split(/\s*(?:&&|\|\||;)\s*/).filter(Boolean);
  if (chained.length > 1) {
    const saved = ctx.cwd;
    for (const part of chained) addCommand(ctx, part);
    ctx.cwd = saved;
    return;
  }

  let m: RegExpExecArray | null;
  m = /^cd\s+(\S+)$/.exec(cmd);
  if (m) {
    ctx.cwd = norm(ctx.cwd, m[1] as string);
    return;
  }
  m = /^(?:NODE_ENV=\S+\s+)?bun\s+run\s+(?:--filter=['"]?\*['"]?\s+)([\w:-]+)/.exec(cmd);
  if (m) {
    addPath(ctx, BUN_CONFIG);
    addPath(ctx, 'package.json');
    for (const ws of workspaces(ctx)) {
      ctx.files.add(`${ws}/package.json`);
      const script = packageScripts(ctx, ws)[m[1] as string];
      if (!script) continue;
      const saved = ctx.cwd;
      ctx.cwd = ws;
      addCommand(ctx, script);
      ctx.cwd = saved;
    }
    return;
  }
  m = /^bun\s+(?:--cwd\s+(\S+)\s+)?(?:run\s+)?([\w:-]+)(?:\s+--\s+.*)?$/.exec(cmd);
  if (m) {
    const dir = m[1] ? norm(ctx.cwd, m[1]) : ctx.cwd;
    const script = packageScripts(ctx, dir)[m[2] as string];
    if (script !== undefined) {
      addPath(ctx, BUN_CONFIG);
      addPath(ctx, norm(dir, 'package.json'));
      const saved = ctx.cwd;
      ctx.cwd = dir;
      addCommand(ctx, script);
      ctx.cwd = saved;
      return;
    }
    if (m[1]) {
      // `bun --cwd <dir> <bin>` with no script of that name: a tool run over the directory.
      addPath(ctx, dir);
      return;
    }
  }
  m = /^(?:\w+=\S+\s+)*bun\s+test\b(.*)$/.exec(cmd);
  if (m) {
    addPath(ctx, BUN_CONFIG);
    const args = (m[1] as string).trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] as string;
      if (arg === '--preload') addScript(ctx, norm(ctx.cwd, args[++i] as string));
      else if (arg === '--timeout') i++;
      else if (!arg.startsWith('-')) addPath(ctx, norm(ctx.cwd, arg));
    }
    return;
  }
  m = /^(?:\w+=\S+\s+)*bun\s+(\S+\.(?:ts|tsx|js|mjs))\b/.exec(cmd);
  if (m) {
    addPath(ctx, BUN_CONFIG);
    addScript(ctx, norm(ctx.cwd, m[1] as string));
    return;
  }
  if (/^biome\s+check\b/.test(cmd)) {
    const config = ctx.repo.read('biome.json');
    ctx.files.add('biome.json');
    const includes =
      (config && (JSON.parse(config) as { files?: { includes?: string[] } }).files?.includes) || [];
    for (const g of includes) addGlob(ctx, g);
    return;
  }
  if (/^knip\b/.test(cmd)) {
    addPath(ctx, 'knip.json');
    for (const ws of workspaces(ctx)) ctx.files.add(`${ws}/package.json`);
    for (const f of ctx.repo.files) {
      if (/^(apps|packages|scripts)\/.*\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f)) ctx.files.add(f);
    }
    return;
  }
  if (/^bun\s+install\b/.test(cmd)) {
    addInstall(ctx);
    return;
  }
  if (/^syncpack\b/.test(cmd)) {
    addPath(ctx, '.syncpackrc.json');
    addPath(ctx, 'package.json');
    for (const ws of workspaces(ctx)) ctx.files.add(`${ws}/package.json`);
    return;
  }
  m = /^tsgo\b.*?(?:-p\s+(\S+))?$/.exec(cmd);
  if (m) {
    const project = norm(ctx.cwd, m[1] ?? 'tsconfig.json');
    addTsProject(ctx, project);
    return;
  }
  if (/^(astro|vite|next)\s+(check|build)\b/.test(cmd)) {
    // A framework build consumes the workspace it runs in.
    addPath(ctx, ctx.cwd);
    return;
  }
  m = /^bunx\s+playwright\s+test\b/.exec(cmd);
  if (m) {
    addPath(ctx, ctx.cwd);
    return;
  }
  m = /^cp\s+(\S+)\s+\S+$/.exec(cmd);
  if (m) {
    addPath(ctx, norm(ctx.cwd, m[1] as string));
    return;
  }
  m = /^docker\s+build\b.*?-f\s+(\S+).*\s(\S+)$/.exec(cmd);
  if (m) {
    const context = norm(ctx.cwd, m[2] as string);
    const target = /--target[=\s]+(\S+)/.exec(cmd)?.[1] ?? null;
    addDockerfile(ctx, norm(ctx.cwd, m[1] as string), context, target);
    return;
  }
  if (/^docker\s+compose\b.*\bup\b/.test(cmd)) {
    addCompose(ctx);
    return;
  }
  if (NO_INPUT.some((re) => re.test(cmd))) return;
  ctx.unresolved.push(cmd);
}

function addTsProject(ctx: Ctx, project: string): void {
  if (ctx.seen.has(project)) return;
  ctx.seen.add(project);
  const text = ctx.repo.read(project);
  if (text === null) {
    ctx.unresolved.push(`tsconfig not in tree: ${project}`);
    return;
  }
  ctx.files.add(project);
  const dir = project.split('/').slice(0, -1).join('/');
  const extendsMatch = /"extends"\s*:\s*"([^"]+)"/.exec(text);
  if (extendsMatch?.[1]?.startsWith('.')) addTsProject(ctx, norm(dir, extendsMatch[1]));
  // `include` when the project names one, else TypeScript's default: every
  // .ts under the project's directory. JSON is pulled in by import, and the
  // imports are already .ts files under the same directory.
  const include = /"include"\s*:\s*\[([^\]]*)\]/.exec(text)?.[1];
  const globs = include
    ? [...include.matchAll(/"([^"]+)"/g)].map((g) => norm(dir, g[1] as string))
    : [dir === '' ? '**/*' : `${dir}/**/*`];
  for (const f of ctx.repo.files) {
    if (!/\.(ts|tsx|mts|cts)$/.test(f)) continue;
    if (
      globs.some((g) =>
        globMatches(
          /\.\w+$|\*$/.test(g) && !g.endsWith('*') ? g : `${g.replace(/\/?\*\*?\/?\*?$/, '')}/**/*`,
          f
        )
      )
    )
      ctx.files.add(f);
  }
}

function expandMatrix(value: unknown, matrix: Record<string, unknown> | undefined): string[] {
  const text = String(value ?? '');
  const m = /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/.exec(text);
  if (!m) return text ? [text] : [];
  const key = m[1] as string;
  const include = (matrix?.include as Record<string, unknown>[] | undefined) ?? [];
  const values = [
    ...((matrix?.[key] as unknown[] | undefined) ?? []),
    ...include.map((row) => row[key]),
  ];
  return values.filter((v) => v !== undefined).map(String);
}

export function inputsOf(
  job: GatedJob,
  repo: RepoView,
  workflows: readonly WorkflowFile[]
): JobInputs {
  const file = workflows.find((w) => w.path === job.workflow);
  const def = file ? parseWorkflow(file.text).jobs?.[job.jobId] : undefined;
  const ctx: Ctx = {
    repo,
    cwd: '',
    seen: new Set(),
    files: new Set(),
    trees: new Set(),
    builds: [],
    unresolved: [],
  };
  if (!def) {
    return {
      files: [],
      trees: [],
      builds: [],
      unresolved: [`job not found: ${job.workflow}#${job.jobId}`],
    };
  }

  ctx.files.add(job.workflow);
  for (const step of def.steps ?? []) {
    const uses = step.uses ?? '';
    if (uses.startsWith('./')) {
      const dir = norm('', uses);
      for (const f of repo.files) if (f.startsWith(`${dir}/`)) ctx.files.add(f);
      const action = repo.read(`${dir}/action.yml`) ?? '';
      if (/\bbun install\b/.test(action)) addInstall(ctx);
      continue;
    }
    if (uses.startsWith('docker/build-push-action')) {
      const context = norm('', String(step.with?.context ?? '.'));
      for (const dockerfile of expandMatrix(step.with?.file, def.strategy?.matrix)) {
        addDockerfile(
          ctx,
          norm('', dockerfile),
          context,
          step.with?.target ? String(step.with.target) : null
        );
      }
      continue;
    }
    if (!step.run) continue;
    ctx.cwd = norm('', step['working-directory'] ?? '');
    // One logical command per line; a trailing backslash continues it.
    for (const line of step.run.replace(/\\\n\s*/g, ' ').split('\n')) addCommand(ctx, line);
  }

  const trees = [...ctx.trees].sort();
  const files = [...ctx.files].filter((f) => !trees.some((t) => f.startsWith(t))).sort();
  return { files, trees, builds: ctx.builds, unresolved: [...new Set(ctx.unresolved)] };
}

export interface Gap {
  readonly path: string;
  /** The tree the path was consumed through, or null when named on its own. */
  readonly via: string | null;
}

/** Every consumed file the job's gate cannot see. Empty is the healthy reading. */
export function uncoveredInputs(job: GatedJob, inputs: JobInputs, repo: RepoView): Gap[] {
  const seen = (path: string) => job.globs.some((g) => globMatches(g, path));
  const gaps: Gap[] = [];
  for (const path of inputs.files) if (!seen(path)) gaps.push({ path, via: null });
  for (const tree of inputs.trees) {
    for (const path of repo.files) {
      if (path.startsWith(tree) && !seen(path)) gaps.push({ path, via: tree || '.' });
    }
  }
  return gaps;
}

// ---------------------------------------------------------------------------
// Buildkite
// ---------------------------------------------------------------------------

export interface PipelineFile {
  readonly path: string;
  readonly text: string;
}

/**
 * Every Buildkite step that could skip on WHAT CHANGED rather than on which
 * build this is. The private repository's CI has no path filters, and this is
 * the check that keeps that true: `if_changed` is where one would appear, and
 * an `if:` or a command reading the diff is the same thing spelled by hand.
 */
export function buildkitePathGates(pipelines: readonly PipelineFile[]): string[] {
  const findings: string[] = [];
  const diffy = /\bif_changed\b|git\s+diff\b|--name-only|changed_files|build\.changed/;
  const walk = (path: string, steps: unknown): void => {
    if (!Array.isArray(steps)) return;
    for (const step of steps) {
      if (!step || typeof step !== 'object') continue;
      const s = step as Record<string, unknown>;
      const label = String(s.key ?? s.label ?? s.group ?? '?');
      if ('if_changed' in s) findings.push(`${path}#${label}: if_changed`);
      if (typeof s.if === 'string' && diffy.test(s.if))
        findings.push(`${path}#${label}: if ${s.if}`);
      const commands = Array.isArray(s.command) ? s.command : [s.command ?? s.commands];
      for (const c of commands.flat()) {
        if (typeof c === 'string' && diffy.test(c))
          findings.push(`${path}#${label}: command reads the diff`);
      }
      walk(path, s.steps);
    }
  };
  for (const file of pipelines) {
    const doc = Bun.YAML.parse(file.text) as { steps?: unknown };
    walk(file.path, doc.steps);
  }
  return findings;
}

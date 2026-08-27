/**
 * Who calls a tRPC procedure — both call forms, one instrument (SC-728).
 *
 * A procedure in this repo is reached two ways, and only one of them is a
 * thing a type checker or a typed-client grep can see:
 *
 *   trpc.widgets.listForOwner.useQuery()                 typed client
 *   `${API_BASE_URL}` + `/trpc/` + `widgets.listForOwner`  a runtime string
 *
 * **Every procedure path in this file and its test is FICTIONAL, and that is
 * load-bearing rather than coy.** This module is scanned by its own census, and
 * it does not treat a comment as prose — deliberately, because a heuristic that
 * did hid all five URL-only callers when SC-728 was measured. So a real path
 * spelled out here IS a caller of it. Measured: an earlier draft of this very
 * docblock used two real ones and moved them out of the URL-only set,
 * over-reporting callers, which is the direction that under-reports dead code
 * silently. `scripts/tests/api-procedure-callers.test.ts` pins it.
 *
 * SC-728 measured what that costs a census: 35 of the api's procedures are
 * reached by the second form, and FIVE have no other caller at all — including
 * `clientErrors.report`, which is the app's own crash reporter and is live in
 * production (`apps/frontend/app/src/lib/report-client-error.ts`). Every one of
 * those five reads as DEAD to any `trpc.<router>.<proc>` sweep, so a deletion
 * pass trusting one would have removed the crash reporter.
 *
 * **It cannot be fixed by widening the accessor list.** Adding `useUtils()`,
 * `createCaller` and `useSuspenseQuery` to a typed-client pattern found eight
 * more live procedures and was worth doing — but no accessor list reaches a
 * string assembled at runtime. A URL built as `${apiBase}` plus a
 * slash-trpc-slash path contains no dotted `trpc.<router>.<proc>` substring in
 * any form a typed pattern matches.
 *
 * THE DENOMINATOR COMES FROM THE RUNTIME ROUTER, NOT FROM A REGEX.
 *
 * `scripts/api-procedure-callers.ts` reads `appRouter._def.procedures`, the
 * same move `apps/backend/api/tests/presentation/lib/strict-input.test.ts`
 * makes and for the same reason. A regex over the router sources would have to
 * know that `routers/client-errors.ts` mounts as `clientErrors` and that
 * `tokens` is built by a `createTokensRouter` factory — two things the file
 * names do not say, and both silently produce a procedure list that is missing
 * entries rather than one that errors.
 *
 * EXTRACT-THEN-INTERSECT, WHICH IS WHY THE PREFIX COLLISION CANNOT HAPPEN.
 *
 * SC-728 records two bugs in the sweep that produced it, both pushing toward
 * *"this procedure is called"* — a prefix collision (`transferReview.list`
 * matching `transferReview.listPending`) and a heuristic treating any
 * backticked line as prose, which discarded every hand-built URL at once
 * because they are all template literals.
 *
 * Neither is guarded against here; both are unreachable. The scan pulls whole
 * identifiers out of each line and intersects them with the procedure set
 * afterwards, so `transferReview.listPending` yields the token
 * `transferReview.listPending` and never `transferReview.list` — there is no
 * substring test to get a boundary wrong on. And nothing is classified as
 * prose: comments and template literals are scanned exactly like code, which
 * over-reports (a docblock illustrating a URL is a "reference") in the
 * direction that is loud rather than silent.
 *
 * That distinction is the ticket's own point. Over-reporting callers
 * UNDER-reports dead code, silently. So the report separates the forms rather
 * than summing them: a reader can see what a typed-only sweep would have said
 * and what it would have missed, instead of being handed one number.
 *
 * WHAT THIS CANNOT SEE — printed by the CLI beside every count, because a
 * census that does not name its floor gets quoted for more than it measured:
 *
 *   - dynamic construction: `trpc[routerName][procName]`, or a URL whose
 *     procedure segment comes from a variable. Nothing textual reaches those.
 *   - any caller outside this repository — a saved request, a curl in
 *     somebody's notes, an integration nobody wrote down. An api procedure
 *     with no caller here is a QUESTION, never a deletion list (SC-680).
 *   - anything not yet committed. The file population is `git ls-files`, so a
 *     call site you have written and not staged is invisible, and the run is
 *     green about a tree that does not contain it.
 */

/** A `<router>.<procedure>` pair as it appeared in source, with where. */
export interface ProcedureRef {
  /** e.g. `groups.getHoldingGroups` */
  path: string;
  file: string;
  /** 1-indexed. */
  line: number;
}

/** Accessors a typed tRPC call is reached through in this repo. */
const TYPED_ACCESSORS = ['trpc', 'trpcClient', 'client', 'utils', 'caller', 'api'] as const;

const IDENT = '[A-Za-z_$][A-Za-z0-9_$]*';

/**
 * A maximal dotted chain: `trpc.<router>.<nested>.<proc>.useMutation`.
 *
 * NOTHING HERE COUNTS SEGMENTS, AND THAT IS THE WHOLE POINT.
 *
 * The first version of this file assumed a procedure is `<router>.<proc>` and
 * matched exactly two segments after an accessor. It reported SEVEN live
 * procedures as having no caller — caught only because the count moved against
 * an earlier measurement, which is the one thing that pointed at it:
 *
 *   a NESTED router — `trpc.<router>.<nested>.<proc>.useMutation()`. The
 *     procedure path is three segments, so a two-segment pattern captures
 *     `<router>.<nested>`, a router, matching nothing — and never the
 *     procedure. Five of the seven, all under `transferReview`.
 *   a TWO-WORD accessor — `utils.client.<router>.<proc>.query()`. The pattern
 *     consumes `utils`, then captures `client.<router>`. Two of the seven,
 *     both in shipped frontend code, both under `exports`.
 *
 * So the chain is taken whole and every contiguous slice of it is tested
 * against the procedure set instead. A nested router of any depth and an
 * accessor of any depth both fall out; there is no arity to get wrong.
 *
 * The irony is load-bearing rather than decorative: an instrument built to
 * stop a sweep reporting live procedures as dead did exactly that, in its
 * first run, for a reason its own docblock did not anticipate.
 *
 * `\s*` around the dots is there for a third shape — a chain Biome wraps
 * across a line, which a line-oriented scan cannot see. **Zero of those exist
 * in the tree today** (measured 2026-08-28 over all 1982 scanned files), so
 * that is a capability with no live instance rather than a fix for an observed
 * bug. It is pinned by a fixture in `scripts/tests/api-procedure-callers.test.ts`
 * precisely because the tree cannot exercise it: a zero from a probe that
 * could not have found anything is worth nothing, and the fixture is what
 * makes this one a measurement.
 */
const CHAIN = new RegExp(`${IDENT}(?:\\s*\\.\\s*${IDENT})+`, 'g');

/** `/trpc/` immediately followed by a dotted chain. */
const URL_CHAIN = new RegExp(`/trpc/(${IDENT}(?:\\.${IDENT})+)`, 'g');

function lineOf(lineStarts: number[], index: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((lineStarts[mid] as number) <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function lineStartsOf(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/**
 * Every `/trpc/<chain>` reference in one file's source.
 *
 * The chain is reported whole. A URL path is anchored — a URL ending
 * `<a>.<b>.<c>` means that procedure and not `<a>.<b>` — so a caller naming
 * something no router defines must surface as unresolved rather than being
 * quietly resolved to a prefix of itself.
 *
 * The angle brackets are load-bearing, not typography: written as a real
 * example this sentence would BE a `/trpc/` reference in a tracked file, and
 * the guard in `scripts/tests/api-procedure-callers.test.ts` would report this
 * module as a caller of a procedure that does not exist. Same remedy as
 * `check-oss-internal-refs.ts`, for the same reason.
 */
export function findUrlRefs(source: string, file: string): ProcedureRef[] {
  const starts = lineStartsOf(source);
  const out: ProcedureRef[] = [];
  URL_CHAIN.lastIndex = 0;
  let m = URL_CHAIN.exec(source);
  while (m !== null) {
    out.push({ path: m[1] as string, file, line: lineOf(starts, m.index) });
    m = URL_CHAIN.exec(source);
  }
  return out;
}

/**
 * Every procedure reached through a typed accessor in one file's source.
 *
 * `isProcedure` is passed in rather than a segment count being assumed: the
 * scan finds chains, and the procedure set decides which slice of a chain is
 * the procedure. See `CHAIN` for the two shapes that motivated it.
 */
export function findTypedRefs(
  source: string,
  file: string,
  isProcedure: (path: string) => boolean
): ProcedureRef[] {
  const starts = lineStartsOf(source);
  const out: ProcedureRef[] = [];
  CHAIN.lastIndex = 0;
  let m = CHAIN.exec(source);
  while (m !== null) {
    const segments = (m[0] as string).split('.').map((s) => s.trim());
    if ((TYPED_ACCESSORS as readonly string[]).includes(segments[0] as string)) {
      const line = lineOf(starts, m.index);
      // Slices starting past the accessor, longest first so a nested router
      // wins over a two-segment prefix of the same chain.
      for (let i = 1; i < segments.length; i++) {
        for (let j = segments.length; j - i >= 2; j--) {
          const path = segments.slice(i, j).join('.');
          if (isProcedure(path)) {
            out.push({ path, file, line });
            break;
          }
        }
      }
    }
    m = CHAIN.exec(source);
  }
  return out;
}

/**
 * Files whose `/trpc/…` strings DECLARE a procedure rather than call one.
 *
 * The data-provider's routers carry a `path:` field holding their own
 * `/trpc/` + `<router>.<proc>` string so `buildOpenApiDocument` can publish
 * them. Counting a procedure's own OpenAPI
 * declaration as a caller of itself is the over-report this whole module is
 * about, one level in — and it is how SC-728's own supporting list came to
 * name three call sites that are not api procedures at all.
 */
const DEFINITION_PREFIXES = [
  'apps/backend/api/src/presentation/router',
  'apps/backend/data-provider/src/presentation/router',
] as const;

export function isDefinitionSite(file: string): boolean {
  return DEFINITION_PREFIXES.some((p) => file.startsWith(p));
}

/**
 * `/trpc/` strings that deliberately name no procedure.
 *
 * Declared one path at a time with the reason, so that using this list means
 * asserting something you believe rather than clearing a red. A file added
 * here stops being checked; a file added here for a bad reason is a caller
 * nobody will ever look at again.
 */
export const FIXTURE_URLS: ReadonlyArray<{ file: string; path: string; why: string }> = [
  {
    file: 'apps/frontend/app/tests/public/sw.test.ts',
    path: 'holdings.list',
    why: "sw.js matches `API_ROUTES = ['/trpc']`, a PREFIX — the procedure segment is never read, so any `/trpc/…` string exercises the same branch and this one names nothing on purpose",
  },
  {
    file: 'apps/frontend/app/tests/public/sw.test.ts',
    path: 'holdings.create',
    why: 'same fixture, the write-path arm; see the note on `holdings.list` above',
  },
  {
    file: 'apps/e2e/scripts/measure-cold-boot.ts',
    path: 'a.b',
    why: 'a docblock illustrating the batched-URL shape `<a>.<b>,<c>.<d>?batch=1`, not a request. Written out as a real URL this line would itself be an unresolved reference — see `findUrlRefs`',
  },
];

function isDeclaredFixture(file: string, path: string): boolean {
  return FIXTURE_URLS.some((f) => f.file === file && f.path === path);
}

/** Which router a `<router>.<proc>` string resolves to. */
export type Resolution = 'api' | 'data-provider' | 'both' | 'unresolved';

/**
 * `both` is a real answer, not a failure to decide.
 *
 * `tokens.search` exists on the api AND on the data-provider, so the string
 * alone cannot say which service a URL addresses — that is carried by the base
 * it is concatenated onto. Collapsing it to either one would be a confident
 * answer to a question the input does not contain.
 */
export function resolve(path: string, api: Set<string>, dataProvider: Set<string>): Resolution {
  const inApi = api.has(path);
  const inDp = dataProvider.has(path);
  if (inApi && inDp) return 'both';
  if (inApi) return 'api';
  if (inDp) return 'data-provider';
  return 'unresolved';
}

export interface CensusInput {
  apiProcedures: string[];
  dataProviderProcedures: string[];
  /** Every scanned file, as `[repoPath, source]`. Definition sites included; filtered here. */
  files: ReadonlyArray<readonly [string, string]>;
}

export interface Census {
  /**
   * The denominator itself, not only its size. Exposed because an absence
   * assertion about the census's own source ("it names no real procedure") is
   * vacuously true over an empty set, so the test needs the set to prove it
   * loaded one — see the controls in `api-procedure-callers.test.ts`.
   */
  apiProcedures: string[];
  apiProcedureCount: number;
  /** Exposed for the same reason as `apiProcedures` — see the guard's controls. */
  dataProviderProcedures: string[];
  dataProviderProcedureCount: number;
  filesScanned: number;
  /** api procedures reached by a hand-built URL, whether or not also typed. */
  reachedByUrl: string[];
  /** api procedures reached by a hand-built URL and by NOTHING else. */
  urlOnly: string[];
  /** api procedures reached only through a typed accessor. */
  typedOnly: string[];
  /** api procedures with no caller anywhere in the scanned tree. */
  noCaller: string[];
  /** URL references naming no procedure on either router, minus declared fixtures. */
  unresolvedUrls: ProcedureRef[];
  /** Declared fixtures actually seen, so a stale declaration is visible. */
  fixturesSeen: ProcedureRef[];
}

export function census(input: CensusInput): Census {
  const api = new Set(input.apiProcedures);
  const dataProvider = new Set(input.dataProviderProcedures);

  const urlHits = new Set<string>();
  const typedHits = new Set<string>();
  const unresolvedUrls: ProcedureRef[] = [];
  const fixturesSeen: ProcedureRef[] = [];
  let filesScanned = 0;

  for (const [file, source] of input.files) {
    if (isDefinitionSite(file)) continue;
    filesScanned++;

    for (const ref of findUrlRefs(source, file)) {
      if (isDeclaredFixture(file, ref.path)) {
        fixturesSeen.push(ref);
        continue;
      }
      const where = resolve(ref.path, api, dataProvider);
      if (where === 'unresolved') unresolvedUrls.push(ref);
      // `both` counts for the api too: the api IS one of the services it may
      // address, and excluding it would under-report a caller.
      if (where === 'api' || where === 'both') urlHits.add(ref.path);
    }

    for (const ref of findTypedRefs(source, file, (p) => api.has(p))) {
      typedHits.add(ref.path);
    }
  }

  const reachedByUrl: string[] = [];
  const urlOnly: string[] = [];
  const typedOnly: string[] = [];
  const noCaller: string[] = [];

  for (const p of [...api].sort()) {
    const byUrl = urlHits.has(p);
    const byTyped = typedHits.has(p);
    if (byUrl) reachedByUrl.push(p);
    if (byUrl && !byTyped) urlOnly.push(p);
    else if (!byUrl && byTyped) typedOnly.push(p);
    else if (!byUrl && !byTyped) noCaller.push(p);
  }

  return {
    apiProcedures: [...api].sort(),
    apiProcedureCount: api.size,
    dataProviderProcedures: [...dataProvider].sort(),
    dataProviderProcedureCount: dataProvider.size,
    filesScanned,
    reachedByUrl,
    urlOnly,
    typedOnly,
    noCaller,
    unresolvedUrls,
    fixturesSeen,
  };
}

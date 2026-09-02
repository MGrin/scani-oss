import '../../i18n-preload';
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { REVIEW_PATH } from '@scani/shared';
import * as routes from '../../../src/v3/lib/routes';

/**
 * Every destination v3 registers can be reached without typing its URL
 * (SC-849).
 *
 * A route that exists, works, and renders correctly is indistinguishable from
 * a missing feature if nothing links to it. There is no error, no 404 and no
 * empty state — the screen is perfect and unreachable, so nothing fails and
 * nothing reports. `/review/balances` shipped in that state and stayed there:
 * `BALANCE_GAP_REVIEW_PATH` appeared in exactly two places, the line that
 * defines it and the line that registers it.
 *
 * Two halves, and the second is useless without the first:
 *
 * 1. **The table is the whole table.** Every `relative(...)` in `V3App`
 *    resolves to an exported path from `routes.ts`, and the bare string paths
 *    it also registers are named here one by one. Without that, a new screen
 *    registered as `<Route path="balances" …>` would satisfy the reachability
 *    half by not being in it.
 * 2. **Every entry in the table is reachable.** Either the path is a nav
 *    destination — the tab bar, the More drawer or the sidebar, which is the
 *    strongest reachability there is — or some file under `src/` other than
 *    `routes.ts` and `V3App.tsx` names the constant.
 *
 * **What deliberately does not count, and why the exclusion is the point.**
 * `ReviewFeedService` mints `href: BALANCE_GAP_REVIEW_PATH` in `@scani/domain`,
 * which is how that screen was reachable at all. Two things are still wrong
 * with counting it. It is conditional on the queue being non-empty, so the way
 * in disappears exactly when somebody wants to look at what they have already
 * answered. And it is a row the app decides to mention, which is a *shortcut*,
 * not navigation: `RealizedLedger` and `CoverageNote` are the same shape and
 * are good precisely because something else already leads there.
 *
 * A third reason has been fixed and is gone (SC-861): it used to be a bare
 * `'/review/balances'`, a second spelling of a path `routes.ts` owned that no
 * rename followed. Both sides now read `@scani/shared`, and the check below
 * keeps this file's half of that true.
 *
 * So this scans `apps/frontend/app/src` alone. A destination that only a
 * server-side string reaches reads as unreachable here, and that is the
 * finding rather than a false positive.
 *
 * Comments are stripped before matching and import lines are dropped. An
 * identifier named in prose is not a link, and this repo has already been told
 * the opposite of the truth twice by a grep that counted one.
 */

const APP_SRC = resolve(import.meta.dir, '../../../src');
const V3_SRC = join(APP_SRC, 'v3');
const ROUTES_FILE = join(V3_SRC, 'lib/routes.ts');
const V3APP_FILE = join(V3_SRC, 'V3App.tsx');

/**
 * Paths `V3App` registers as bare strings rather than from the table, each
 * with the reason it is not a destination anybody needs a link to. A new one
 * has to be argued for here, which is the whole guard: this list is what stops
 * "register it as a literal" from being a way out of the check below.
 */
const UNTABLED_ROUTES: Record<string, string> = {
  'kitchen-sink/:peekId?':
    'the primitive gallery (V3-06) — deliberately unlinked, and not in the bundle either',
  files: 'a redirect to /documents kept for links minted before V3-43 renamed it',
  '*': 'the terminal 404 (SC-423), which is every path that matched nothing',
};

/** A destination as it is written where it is used: `V3_ROUTES.review`,
 *  `TRANSFER_REVIEW_PATH`, `V3_CAPTURE_ROUTES.fileImport`. Matching on the
 *  source text rather than the resolved path is what makes a builder like
 *  `integrationConnectPath` checkable at all. */
interface Destination {
  /** The expression a caller writes. */
  expr: string;
  /** Where it lands, for the nav comparison. Builders are probed. */
  path: string;
}

const PROBE = 'probe';

/** The path a value stands for, or null if it is not a path at all. */
function toPath(value: unknown): string | null {
  if (typeof value === 'string') return value.startsWith('/') ? value : null;
  if (typeof value === 'function') {
    // A path builder answers with a path; `resolveActiveV3Path` and its
    // sibling answer with null for a probe, which is how they fall out here
    // without being named.
    const produced = (value as (arg: string) => unknown)(PROBE);
    return typeof produced === 'string' && produced.startsWith('/') ? produced : null;
  }
  return null;
}

/** Every path `routes.ts` exports, including the members of its objects. */
function destinations(): Destination[] {
  const found: Destination[] = [];
  for (const [name, value] of Object.entries(routes)) {
    const direct = toPath(value);
    if (direct !== null) {
      found.push({ expr: name, path: direct });
      continue;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    for (const [key, member] of Object.entries(value)) {
      const path = toPath(member);
      if (path !== null) found.push({ expr: `${name}.${key}`, path });
    }
  }
  return found.sort((a, b) => a.expr.localeCompare(b.expr));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/**
 * The file with everything that is not code removed: block comments, line
 * comments, and the import statements that carry an identifier into a module
 * without using it. What is left is the places a destination is actually
 * reached.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(
      (line) => !/^\s*(?:import|export)\b/.test(line) && !/^\s*(?:\}?\s*from\s|\/\/)/.test(line)
    )
    .join('\n');
}

const NAV_PATHS = new Set(routes.V3_NAV_PATHS);

const LINKING_FILES = sourceFiles(APP_SRC)
  .filter((file) => file !== ROUTES_FILE && file !== V3APP_FILE)
  .map((file) => ({ file, code: code(file) }));

/** Which files link to a destination, by the expression a caller writes. */
function linksTo(expr: string): string[] {
  return LINKING_FILES.filter(({ code: body }) => body.includes(expr))
    .map(({ file }) => file.replace(`${APP_SRC}/`, 'src/'))
    .sort();
}

const V3APP = readFileSync(V3APP_FILE, 'utf8');

describe('the route table is the whole route table', () => {
  test('every registered route names a path from routes.ts, or is named here', () => {
    const registered = [...V3APP.matchAll(/<Route\b[\s\S]*?(?=\/?>)/g)].map((match) => match[0]);
    // A guard that enumerates nothing passes on an empty file.
    expect(registered.length).toBeGreaterThan(30);

    const untabled: string[] = [];
    for (const element of registered) {
      if (/\bpath=\{[^}]*\brelative\(/.test(element)) continue;
      const literal = /\bpath="([^"]*)"/.exec(element);
      if (!literal?.[1]) continue; // `<Route index>` and layout routes carry no path.
      if (!(literal[1] in UNTABLED_ROUTES)) untabled.push(literal[1]);
    }
    expect(untabled).toEqual([]);
  });

  test('the review paths are not respelled here', () => {
    // `@scani/shared` owns them, because `ReviewFeedService` mints them into a
    // feed row's href and cannot import this app (SC-861). Re-adding a literal
    // on this side breaks the pair exactly as silently as the server-side
    // literal did — the row still renders, and it resolves to the catch-all.
    // The mirror of this check, over `@scani/domain`, is
    // `tests/services/review-route-spelling.test.ts` in that package.
    //
    // Comments only are stripped: `code()` also drops `export` lines, and an
    // `export const TRANSFER_REVIEW_PATH = '/review/transfers'` is precisely
    // the line that would come back.
    const withoutComments = readFileSync(ROUTES_FILE, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line))
      .join('\n');
    expect(withoutComments).toContain('V3_ROUTES');
    expect(
      [`'${REVIEW_PATH}`, `"${REVIEW_PATH}`, `\`${REVIEW_PATH}`].filter((spelling) =>
        withoutComments.includes(spelling)
      ),
      'routes.ts writes a review path as a string literal. It is owned by @scani/shared so ' +
        'the server and this route table cannot drift apart; import it instead.'
    ).toEqual([]);
  });

  test('every relative() argument is an export of routes.ts', () => {
    // `(?<!function )` so the helper's own declaration is not read as a call.
    const named = [...V3APP.matchAll(/(?<!function )\brelative\(([^)]+)\)/g)].map((match) =>
      (match[1] ?? '').trim()
    );
    expect(named.length).toBeGreaterThan(20);

    const known = new Set(destinations().map((destination) => destination.expr));
    expect(named.filter((expr) => !known.has(expr))).toEqual([]);
  });
});

describe('every destination can be reached without typing its URL', () => {
  const all = destinations();

  test('there are destinations to check at all', () => {
    // The classifier above returns null for anything that is not a path, so a
    // refactor that broke it would empty this list and pass every case below.
    expect(all.length).toBeGreaterThan(20);
  });

  test.each(
    all.map((destination) => [destination.expr, destination] as const)
  )('%s', (_expr, destination) => {
    if (NAV_PATHS.has(destination.path)) return;
    const inbound = linksTo(destination.expr);
    expect(
      inbound,
      `${destination.expr} (${destination.path}) is registered in V3App and nothing in src/ ` +
        'links to it, so it is reachable only by typing the URL. Give it a nav entry or a ' +
        'Link from the surface a reader would look for it on.'
    ).not.toEqual([]);
  });
});

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SC-1094, the residual of SC-1064.
 *
 * `/audit-log` tells the operator "Sensitive payload fields are never written
 * here." SC-1064 gave that claim a guard over the rows the ADMIN APP authors
 * (`apps/frontend/admin/tests/lib/audit-detail-carries-no-payload.test.ts`),
 * and that file says outright what it cannot reach: "it cannot see the
 * BACKEND's own `audit(...)` rows, which reach the same table and the same
 * Detail column through `{ error: msg }` and friends."
 *
 * This is that half. The backend has 18 `await audit(...)` sites in two files,
 * every one of them writing a `details` OBJECT that
 * `admin-data.ts`'s GET handler renders into the page's `detail` field via
 * `JSON.stringify(details)`. Four pass `{ error: msg }`, where `msg` is
 * `err instanceof Error ? err.message : String(err)` from a process holding
 * production credentials.
 *
 * SAME RULE AS SC-1064, DELIBERATELY: a value written by the author of the
 * route cannot carry a payload the author has not read, so every value in a
 * `details` object must be a literal, a template, `undefined`, a number, a
 * boolean, `null`, a module constant, or a ternary of those. Anything else —
 * a bare identifier, a member expression, a call — is a value from somewhere
 * else and has to be DECLARED below with a reason. A second, differently
 * shaped invention here would leave two rules to keep in step over one table.
 *
 * WHY NOT A RUNTIME REDACTOR, which is the obvious alternative at a WRITE
 * site: a redactor cannot recognise a secret it has not seen, and adding one
 * would make the page's claim look enforced while covering only the patterns
 * somebody thought of. The shape rule fires at the one moment a human can
 * judge — when the next route is written.
 *
 * THE SIZE CAP IS ALREADY HERE AND IS A DIFFERENT PROPERTY.
 * `sanitizeAuditDetails` (`apps/backend/api/src/presentation/http/admin-common.ts`,
 * 20 keys / 1024 chars per value) is at this write site already. Its own
 * comment gives its reason as jsonb inflation, and it TRUNCATES rather than
 * removes — so it bounds a leak at 1024 characters rather than preventing one.
 * Nothing here restates length.
 *
 * WHAT THIS DOES NOT REACH, said plainly:
 *   - it reads SOURCE TEXT. A DECLARED identifier that is later reassigned to
 *     hold a payload still passes: the declaration is the judgement, and the
 *     check only makes somebody write one;
 *   - it says nothing about `actor`, `action` or `resource`, which also render
 *     on that page. The claim is scoped to payload fields, and `resource` is a
 *     key or an id by design;
 *   - it bounds no VALUE at runtime, so it prevents no leak that is already
 *     live. It closes the next call site, not this table's history;
 *   - the `detail` forwarded by `POST /admin/audit-log` is the ADMIN APP's
 *     string, and what constrains it is SC-1064's guard on the other side of
 *     the wire. It is DECLARED below pointing there; the two files meet at
 *     exactly that one site and nowhere else.
 */

const REPO = join(import.meta.dir, '..', '..', '..', '..', '..', '..');
const API_SRC = join(REPO, 'apps/backend/api/src');
const HTTP_DIR = join(API_SRC, 'presentation/http');

/**
 * Values that are not literal-shaped, each with why it is allowed. Adding one
 * is asserting you have read what that expression can hold.
 */
const DECLARED: ReadonlyArray<{ file: string; key: string; expr: string; why: string }> = [
  {
    file: 'apps/backend/api/src/presentation/http/admin-data.ts',
    key: 'amountUsd',
    expr: 'amountUsd',
    why: "The override amount, off `validateSpendOverridePayload`, which admits it only when `typeof === 'number' && Number.isFinite && >= 0` and then rounds it to two places. A number that has passed that cannot carry text.",
  },
  {
    file: 'apps/backend/api/src/presentation/http/admin-data.ts',
    key: 'note',
    expr: 'note',
    why: "The operator's own note on a spend override, off the same validator: admitted only as a string, trimmed, and cut to NOTE_MAX_CHARS. It is prose an operator typed into the admin form about their own spend, which is the thing the audit row exists to record.",
  },
  {
    file: 'apps/backend/api/src/presentation/http/admin-data.ts',
    key: 'removed',
    expr: 'removed.length',
    why: "The row count of the DELETE's RETURNING clause — an integer, and the only thing that tells an operator whether the clear hit anything. Not a row, not a value from one.",
  },
  {
    file: 'apps/backend/api/src/presentation/http/admin-data.ts',
    key: 'detail',
    expr: 'detail',
    why: "The ADMIN APP's own `detail` string, forwarded by `POST /admin/audit-log` after the handler has checked `typeof parsed.detail === 'string'`. What constrains its CONTENT is SC-1064's shape rule on the writing side (`apps/frontend/admin/tests/lib/audit-detail-carries-no-payload.test.ts`); this end cannot see the expression that produced it, and declaring it here rather than shape-passing it is what records that.",
  },
  {
    file: 'apps/backend/api/src/presentation/http/admin-jobs.ts',
    key: 'name',
    expr: 'job.name',
    why: "A BullMQ job's registered name — one of the `JOB_NAMES` constants the worker registers, e.g. a schedule slug. It is the job TYPE, not its data, and it is what tells an operator which job they retried or removed.",
  },
  {
    file: 'apps/backend/api/src/presentation/http/admin-jobs.ts',
    key: 'name',
    expr: 'payload.originalName',
    why: "The queue name a DLQ entry records for the job it came from — the same `JOB_NAMES` space as `job.name`, read back off the DLQ payload. The handler has already refused the entry unless this is a non-empty string. It names a job type; the entry's `data` is never written here.",
  },
  {
    file: 'apps/backend/api/src/presentation/http/admin-jobs.ts',
    key: 'jobId',
    expr: 'jobId',
    why: 'A deterministic id this handler MINTS itself — `manualRunJobId(name)` or `replayJobId(id)` over a value already validated against RUNNABLE_SCHEDULE_NAMES or the route param. It is derived here rather than received, and it is what lets an operator find the run they triggered.',
  },
  {
    file: 'apps/backend/api/src/presentation/http/admin-jobs.ts',
    key: 'replayedAt',
    expr: 'String(payload.replayedAt)',
    why: 'The timestamp a previous replay stamped on the DLQ entry, which is the whole reason this 409 can say more than "no". Written by this same handler as `new Date().toISOString()`; `String()` is here because the field is read back off jsonb as `unknown`.',
  },
  {
    file: 'apps/backend/api/src/presentation/http/admin-jobs.ts',
    key: 'error',
    expr: 'msg',
    why: "An upstream error string, `err instanceof Error ? err.message : String(err)`, from a process that reaches Fly, Neon, Redis, Postgres and BullMQ. NOT author-controlled, which is why it is declared rather than shape-passed — this entry is the one that carries risk and the reason SC-1094 exists. It is kept because the message is the only thing that tells an operator why a retry, a manual fire or a replay failed, and dropping it would make every 500 in the audit log identical. What bounds it is `sanitizeAuditDetails`'s 1024 chars, which is a SIZE cap and not a redactor. Probed 2026-09-05 on one client: a `neon()` connect failure against a URL carrying a user and password returns 'Error connecting to database: fetch() URL is invalid' — 52 chars, neither credential echoed. ONE error shape from ONE client, not a proof about the others.",
  },
];

/** Comments removed, so prose mentioning a call is never read as one. */
function strippedOfComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(dir, f));
}

/**
 * Index of the matching close for the bracket at `open`, skipping over string
 * and template literals so a brace or comma inside text is never structural.
 */
function matchingClose(src: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i] as string;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (pairs[c]) depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split on commas at nesting depth 0, ignoring commas inside literals. */
function splitTopLevel(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push(src.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = src.slice(start).trim();
  if (last.length > 0) out.push(last);
  return out;
}

/**
 * Every `audit(` in the source, as `{ argsInner, awaited }`. The identifier
 * boundary keeps `sanitizeAuditDetails(` and any `.audit(` method out.
 */
function auditCalls(src: string): Array<{ argsInner: string; awaited: boolean }> {
  const out: Array<{ argsInner: string; awaited: boolean }> = [];
  for (const m of src.matchAll(/(?<![A-Za-z0-9_$.])audit\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchingClose(src, open);
    if (close === -1) continue;
    const before = src.slice(Math.max(0, m.index - 40), m.index);
    out.push({
      argsInner: src.slice(open + 1, close),
      awaited: /\bawait\s+$/.test(before),
    });
  }
  return out;
}

interface Site {
  file: string;
  key: string;
  expr: string;
}

/**
 * The `details` argument is `audit`'s FIFTH positional parameter
 * (`actor, action, resource, result, details, hmacSecret`). Scoped to that
 * position on purpose: `actor` and `resource` also render on the page, and a
 * matcher that swept every argument would report shapes nobody chose about a
 * claim scoped to payload fields.
 *
 * The argument may be an object literal or a ternary of them
 * (`detail ? { detail } : {}`), so every top-level `{ … }` in it is read.
 */
function detailSites(): Site[] {
  const out: Site[] = [];
  for (const file of tsFilesUnder(HTTP_DIR)) {
    const src = strippedOfComments(readFileSync(file, 'utf8'));
    for (const call of auditCalls(src)) {
      const args = splitTopLevel(call.argsInner);
      const details = args[4];
      if (details === undefined) continue;
      for (const obj of objectLiterals(details)) {
        for (const entry of splitTopLevel(obj)) {
          const colon = entry.indexOf(':');
          // `{ jobId }` is shorthand for `{ jobId: jobId }` — the value is the
          // identifier, and reading it as a literal because no colon is
          // present would pass every bare identifier in the tree.
          const [key, expr] =
            colon === -1
              ? [entry.trim(), entry.trim()]
              : [entry.slice(0, colon).trim(), entry.slice(colon + 1).trim()];
          if (key.length === 0) continue;
          out.push({ file: file.slice(REPO.length + 1), key, expr });
        }
      }
    }
  }
  return out;
}

/** Every top-level `{ … }` in an expression. */
function objectLiterals(expr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i] as string;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (c === '{' && depth === 0) {
      const close = matchingClose(expr, i);
      if (close === -1) return out;
      out.push(expr.slice(i + 1, close));
      i = close;
      continue;
    }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
  }
  return out;
}

/**
 * Split `c ? a : b` into its two VALUE positions, or null. Nesting is counted
 * rather than regex'd so `a ? 'x' : b ? 'y' : 'z'` stays literal — refusing it
 * would push somebody to declare an exception for safe code, which is the
 * escape hatch written while staring at a red build.
 *
 * `?.` and `??` are not ternaries, and a `?` or `:` inside a quote is text.
 */
function splitTernary(expr: string): [string, string] | null {
  let quote: string | null = null;
  let start = -1;
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i] as string;
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (c === '?') {
      if (expr[i + 1] === '.' || expr[i + 1] === '?' || expr[i - 1] === '?') continue;
      if (start === -1) start = i;
      else depth++;
    } else if (c === ':' && start !== -1) {
      if (depth > 0) depth--;
      else return [expr.slice(start + 1, i).trim(), expr.slice(i + 1).trim()];
    }
  }
  return null;
}

/**
 * Literal-shaped: a string or template literal, `undefined`, `null`, a
 * boolean, a numeric literal, a SCREAMING_SNAKE module constant, or a ternary
 * whose branches are those. The condition of a ternary is not read — it
 * selects a value, it is not one.
 */
function isLiteralShaped(expr: string): boolean {
  const ternary = splitTernary(expr);
  if (ternary) return isLiteralShaped(ternary[0]) && isLiteralShaped(ternary[1]);
  if (expr === 'undefined' || expr === 'null' || expr === 'true' || expr === 'false') return true;
  if (/^'[^']*'$/.test(expr) || /^"[^"]*"$/.test(expr)) return true;
  if (/^`[^`]*`$/.test(expr)) return true;
  if (/^-?\d[\d_]*(\.\d+)?$/.test(expr)) return true;
  if (/^[A-Z][A-Z0-9_]*$/.test(expr)) return true;
  return false;
}

/** `${…}` interpolations inside a template literal. */
function interpolations(expr: string): string[] {
  return [...expr.matchAll(/\$\{([^}]*)\}/g)].map((m) => (m[1] as string).trim());
}

describe('backend audit details carry no payload (SC-1094)', () => {
  const sites = detailSites();

  test('the extractor read the tree — otherwise every assertion below is vacuous', () => {
    // must-be-FOUND control. A wrong path, or a parser that matches nothing,
    // reports a clean sweep over zero sites — which is the failure this file
    // exists to prevent, one level up.
    expect(sites.length).toBeGreaterThan(15);
    expect(sites.map((s) => s.expr)).toContain("'not_found'");
    expect(sites.map((s) => s.expr)).toContain('msg');
    expect(new Set(sites.map((s) => s.file))).toEqual(
      new Set([
        'apps/backend/api/src/presentation/http/admin-data.ts',
        'apps/backend/api/src/presentation/http/admin-jobs.ts',
      ])
    );
  });

  test('shorthand is read as a VALUE, not as a literal — must-be-RED control', () => {
    // `{ jobId }` has no colon. A splitter that treated a colon-less entry as
    // a key with no value would classify every shorthand as safe, and six of
    // the sites in this tree are shorthand — `jobId` at three of them.
    const shorthand = sites.filter((s) => s.key === s.expr && !isLiteralShaped(s.expr));
    expect([...new Set(shorthand.map((s) => s.expr))].sort()).toEqual([
      'amountUsd',
      'detail',
      'jobId',
      'note',
    ]);
    expect(shorthand.filter((s) => s.expr === 'jobId')).toHaveLength(3);
  });

  test('the classifier can come back NEGATIVE — must-be-RED control', () => {
    // A classifier that returned true for everything would pass the sweep
    // below over any tree at all.
    expect(isLiteralShaped("'a literal'")).toBe(true);
    expect(isLiteralShaped('`t ${x}`')).toBe(true);
    expect(isLiteralShaped('42')).toBe(true);
    expect(isLiteralShaped("ok ? undefined : 'no'")).toBe(true);
    // Nested, and a `?.` that is not a ternary at all. Both are literal.
    expect(isLiteralShaped("a ? 'x' : b ? 'y' : 'z'")).toBe(true);
    expect(isLiteralShaped('`n=${x?.length ?? 0}`')).toBe(true);
    // A ternary is only as safe as its branches.
    expect(isLiteralShaped("ok ? 'fine' : JSON.stringify(body)")).toBe(false);
    expect(isLiteralShaped('JSON.stringify(body)')).toBe(false);
    expect(isLiteralShaped('err.message')).toBe(false);
    expect(isLiteralShaped('msg')).toBe(false);
    expect(isLiteralShaped('await request.text()')).toBe(false);
    // A `?` inside a quote is text, not a ternary — a splitter that read it
    // would classify an ordinary question as a ternary with junk branches.
    expect(isLiteralShaped("'is it off? yes'")).toBe(true);
  });

  test('every details value is literal-shaped or DECLARED', () => {
    const declared = new Set(DECLARED.map((d) => `${d.file}::${d.key}::${d.expr}`));
    const offenders = sites
      .filter((s) => !isLiteralShaped(s.expr))
      .filter((s) => !declared.has(`${s.file}::${s.key}::${s.expr}`))
      .map((s) => `${s.file}: ${s.key}: ${s.expr}`);
    expect(offenders).toEqual([]);
  });

  test('no template interpolates a request body or a payload', () => {
    // The shape rule alone lets `` `${JSON.stringify(body)}` `` through. This
    // is what narrows it: an interpolation naming the parsed body, a job's
    // data, or a whole-object serialisation is the thing the page's claim is
    // about.
    const banned = /^(body|payload|data|entry|job|parsed)\b|\bJSON\.stringify\b|\brequest\b/;
    const offenders = sites
      .flatMap((s) => interpolations(s.expr).map((i) => ({ ...s, i })))
      .filter((s) => banned.test(s.i))
      .map((s) => `${s.file}: \${${s.i}}`);
    expect(offenders).toEqual([]);
  });

  test('every DECLARED entry still matches a live site — the other direction', () => {
    // An exception that outlives its site pre-authorises the next expression
    // that happens to be spelled the same, in a file nobody is looking at.
    const live = new Set(sites.map((s) => `${s.file}::${s.key}::${s.expr}`));
    const stale = DECLARED.filter((d) => !live.has(`${d.file}::${d.key}::${d.expr}`)).map(
      (d) => `${d.file}: ${d.key}: ${d.expr}`
    );
    expect(stale).toEqual([]);
  });

  test('every DECLARED entry carries a reason', () => {
    expect(DECLARED.filter((d) => d.why.trim().length < 40).map((d) => d.expr)).toEqual([]);
  });

  test('every audit() call is awaited, so none escapes the sweep above', () => {
    // `auditCalls` reads calls whether or not they are awaited, but
    // `detailSites` is the only consumer and a non-awaited call would still be
    // read — this asserts the shape the extractor was written against, so a
    // `void audit(...)` cannot appear without somebody revisiting this file.
    const bare: string[] = [];
    for (const file of tsFilesUnder(API_SRC)) {
      const src = strippedOfComments(readFileSync(file, 'utf8'));
      // The definition itself is `export async function audit(`.
      const isDefinition = /function\s+audit\s*\(/.test(src);
      for (const call of auditCalls(src)) {
        if (call.awaited) continue;
        if (isDefinition && call.argsInner.includes('actor: string')) continue;
        bare.push(`${file.slice(REPO.length + 1)}: audit(${call.argsInner.slice(0, 40)}…`);
      }
    }
    expect(bare).toEqual([]);
  });

  test('audit() is the only writer, so no site can bypass the sweep above', () => {
    // If a handler inserted into `adminAuditLog` directly, its details would
    // never reach `detailSites()` and this file would report clean over it.
    const writers = tsFilesUnder(API_SRC)
      .filter((f) => /\.insert\(\s*adminAuditLog\s*\)/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(REPO.length + 1));
    expect(writers).toEqual(['apps/backend/api/src/presentation/http/admin-common.ts']);
  });
});

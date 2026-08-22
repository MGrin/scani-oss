import { describe, expect, test } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * What VOCABULARY an error reaches a reader in — checked, not remembered.
 *
 * SC-311 made the passthrough opt-in: `showError` renders `userFacingMessage`,
 * which answers only for a `UserFacingError`, a plain `string`, or a server
 * rejection carrying `data.httpStatus`. Everything else becomes
 * `ui.toast.unknownError`. That is the right default and it has two failure
 * modes on either side of it, both silent, and SC-551 found both live:
 *
 * 1. **Deliberate copy wrapped in `new Error(...)` is DISCARDED.** A plain
 *    `Error` passes none of the three doors, so
 *    `showError(new Error(t('v3.holdings.refresh.priceFailed')))` renders
 *    "Unknown error" and the sentence somebody wrote is never seen. Seven
 *    sites did this. Nothing catches it: a toast still appears, it is still
 *    destructive, and the action really did fail — only the words are wrong.
 *
 * 2. **A server-supplied job error must not reach `showError` AT ALL**, and
 *    the tempting fix for (1) is exactly what would ship it. `user_jobs.error`
 *    holds whatever the processor threw — a `DrizzleQueryError` puts a full
 *    `select "id", "user_id", … from "holdings"` in there. Unwrapping
 *    `showError(new Error(status.error ?? t(...)))` to
 *    `showError(status.error ?? t(...))` makes it a bare **string**, which is
 *    door 2, so it renders verbatim. The wrapper looks like it does nothing
 *    and is the only thing standing between that SQL and a toast.
 *
 * Static, because the failure is invisible to type-check and to every
 * component test: `showError` is called from mutation callbacks and effects,
 * both shapes compile, and both produce a red toast.
 */

const SRC = resolve(import.meta.dir, '../../src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** The argument list of every `showError(...)` call, source text, parens balanced. */
export function showErrorArguments(source: string): string[] {
  const out: string[] = [];
  const call = /(?<![.\w])showError\s*\(/g;
  let match = call.exec(source);
  while (match !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      i += 1;
    }
    if (depth === 0) out.push(source.slice(start, i - 1));
    match = call.exec(source);
  }
  return out;
}

/** The first argument — the one `userFacingMessage` is asked about. */
export function firstArgument(args: string): string {
  let depth = 0;
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) return args.slice(0, i).trim();
  }
  return args.trim();
}

/**
 * A FRESH `new Error(...)` handed to `showError`, which is never right.
 *
 * Either the argument is a sentence for a reader — then it belongs through as
 * a `string`, door 2 — or it is a genuine exception, and then the original
 * error object should travel, since only it can carry a `UserFacingError` type
 * or a server `data.httpStatus`. Manufacturing a new `Error` throws away
 * whichever of those the value had and guarantees the generic sentence.
 *
 * Keying on the wrapper rather than on `t(` inside it is deliberate: it also
 * catches `showError(new Error(outcome.message))`, where the copy arrives
 * already translated from a helper and no `t(` is visible at the call site. A
 * narrower rule missed exactly that one.
 *
 * `error instanceof Error ? error : new Error(String(error))` is NOT this and
 * passes: it hands over the original error whenever there is one, and only
 * manufactures a wrapper for a non-`Error` throw that had nothing to preserve.
 */
export function wrapsInFreshError(firstArg: string): boolean {
  return /^new\s+Error\s*\(/.test(firstArg);
}

/** Names bound from `useJobStatus(...)` in this file. */
export function jobStatusBindings(source: string): string[] {
  const out: string[] = [];
  const decl = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*useJobStatus\s*\(/g;
  let match = decl.exec(source);
  while (match !== null) {
    if (match[1]) out.push(match[1]);
    match = decl.exec(source);
  }
  return out;
}

export function referencesJobError(args: string, bindings: string[]): string | null {
  for (const name of bindings) {
    if (new RegExp(`(?<![.\\w])${name}\\.error(?![\\w$])`).test(args)) return name;
  }
  return null;
}

interface Violation {
  file: string;
  detail: string;
}

const FILES = sourceFiles(SRC);

async function scan(): Promise<{ wrapped: Violation[]; jobError: Violation[] }> {
  const wrapped: Violation[] = [];
  const jobError: Violation[] = [];
  for (const file of FILES) {
    const source = stripComments(await Bun.file(file).text());
    if (!source.includes('showError')) continue;
    const where = relative(SRC, file);
    const bindings = jobStatusBindings(source);
    for (const args of showErrorArguments(source)) {
      const first = firstArgument(args);
      if (wrapsInFreshError(first)) {
        wrapped.push({ file: where, detail: first.replace(/\s+/g, ' ').slice(0, 120) });
      }
      const leaked = referencesJobError(args, bindings);
      if (leaked) {
        jobError.push({ file: where, detail: `${leaked}.error` });
      }
    }
  }
  return { wrapped, jobError };
}

describe('the scanner can see what it is looking for', () => {
  /**
   * Deleted last. A guard that only ever fires is indistinguishable from a
   * broken one, and the two rules below are assertions that something is
   * ABSENT — so a scanner that silently matched nothing would report a clean
   * tree forever. These are the positive controls for the two predicates the
   * scan runs, and they exercise the same functions rather than a copy.
   */
  test('it finds a showError call and its first argument', () => {
    const args = showErrorArguments("showError(new Error(t('a.b', { n: 1 })), t('c.d'));");
    expect(args).toHaveLength(1);
    expect(firstArgument(args[0] ?? '')).toBe("new Error(t('a.b', { n: 1 }))");
  });

  test('it flags a freshly manufactured Error, with or without a visible t(', () => {
    expect(wrapsInFreshError("new Error(t('v3.x.y'))")).toBe(true);
    expect(wrapsInFreshError("new Error(status.error ?? t('v3.x.y'))")).toBe(true);
    // The one a `t(`-based rule missed: already-translated copy from a helper.
    expect(wrapsInFreshError('new Error(outcome.message)')).toBe(true);
  });

  test('it does NOT flag handing over the original error, nor a bare string', () => {
    expect(wrapsInFreshError('error instanceof Error ? error : new Error(String(error))')).toBe(
      false
    );
    expect(wrapsInFreshError('error')).toBe(false);
    expect(wrapsInFreshError("t('v3.x.y')")).toBe(false);
  });

  test('it flags a job error both wrapped and bare — the unwrap is the trap', () => {
    const bindings = jobStatusBindings('const status = useJobStatus(jobId);');
    expect(bindings).toEqual(['status']);
    expect(referencesJobError("new Error(status.error ?? t('x'))", bindings)).toBe('status');
    expect(referencesJobError("status.error ?? t('x')", bindings)).toBe('status');
    expect(referencesJobError("t('x')", bindings)).toBeNull();
  });

  test('the tree it scans is not empty', () => {
    expect(FILES.length).toBeGreaterThan(100);
  });
});

describe('a message written for a reader survives to the reader', () => {
  test('no showError manufactures a fresh Error', async () => {
    const { wrapped } = await scan();
    expect(wrapped).toEqual([]);
  });
});

describe('a message nobody wrote for a reader never reaches one', () => {
  /**
   * The one a future reader will want to soften. `showError(status.error ?? t(...))`
   * reads as an improvement — it looks like it prefers the specific message over
   * the generic one — and it is how the raw SQL gets to the toast. The rule is
   * that a server-supplied job error does not reach `showError` in ANY form,
   * because provenance cannot be recovered from the string once it is one
   * (SC-311's whole argument, and why `rejectionReason` gates on the envelope
   * rather than on how the text reads).
   *
   * `user_jobs` now carries a separate column holding only what a processor
   * branded `userFacing(...)`, and the hook surfaces it as `userFacingError`.
   * That value IS vouched for and is shown — under its own name, so this rule
   * never had to be relaxed to allow it. The name is the point: a field called
   * `error` that holds "the sentence for the reader" is the naming that caused
   * this ticket, and the test below is what keeps it from coming back.
   */
  test('no showError is handed a useJobStatus error, wrapped or bare', async () => {
    const { jobError } = await scan();
    expect(jobError).toEqual([]);
  });

  test('useJobStatus exposes no field called `error` for anyone to reach for', async () => {
    // The rule above can only fire on a field that exists, so on its own it
    // would be satisfied forever by the rename rather than by the discipline.
    // This is the assertion with something to bite on: re-add `error` to the
    // hook and the raw throw has a plausible-looking home again.
    const hook = stripComments(await Bun.file(resolve(SRC, 'v3/hooks/useJobStatus.ts')).text());
    expect(hook).toContain('userFacingError: string | null;');
    expect(hook).not.toMatch(/^\s*error: string \| null;$/m);
  });
});

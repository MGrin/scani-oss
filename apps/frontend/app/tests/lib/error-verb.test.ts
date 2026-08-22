import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * Every `describeQueryError` call in this app NAMES ITS VERB.
 *
 * `describeQueryError(error, subject, verb)` defaults `verb` to `'load'`, and
 * that default renders "Couldn't load {{subject}}". The default is right for
 * the kit's `QueryError`, which wraps a *read*. It is wrong everywhere in this
 * app that a submit failed, and `errors.ts` says so in its own doc: "a rejected
 * *connect* that says 'Couldn't load Kraken' describes an action the reader
 * never took."
 *
 * Four capture pages took it anyway — wallet, manual entry, invoice upload,
 * file import — so a failed wallet import rendered "Couldn't load this wallet"
 * to somebody who had just pressed **Watch this wallet** (SC-529, measured on
 * the pixel with the enqueue failing under a held lock).
 *
 * Static, because nothing else can see it. The wrong verb type-checks, renders
 * a red line in the right place, and describes a real failure — only the word
 * is wrong, and no component test asserts a word it was not told to expect.
 *
 * **The rule is "name it", not "do not use `load`".** Passing `'load'`
 * explicitly passes this test. That is deliberate: the defect was a default
 * being *taken*, not a value being wrong, and a rule forbidding `'load'` would
 * be wrong the first time a page here legitimately fails a read.
 *
 * **Why this stays meaningful.** It asserts a property of every call that
 * exists rather than the absence of a known-bad one, so a call site added
 * tomorrow is covered without anyone remembering this file. The one way it
 * could go vacuous is the call set emptying out — the helper renamed, or this
 * app's error copy routed through something else — so the count is asserted
 * non-zero below. If that is the assertion that fails, the rule needs
 * re-pointing at whatever replaced `describeQueryError`, not deleting.
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

/** The argument list of every `describeQueryError(...)` call, parens balanced. */
export function describeQueryErrorArguments(source: string): string[] {
  const out: string[] = [];
  const call = /(?<![.\w])describeQueryError\s*\(/g;
  let match = call.exec(source);
  while (match !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      i++;
    }
    out.push(source.slice(start, i - 1));
    call.lastIndex = i;
    match = call.exec(source);
  }
  return out;
}

/** Top-level commas only — a subject like `t('a', { b })` must not count as two. */
export function topLevelArgumentCount(args: string): number {
  if (args.trim() === '') return 0;
  let depth = 0;
  let count = 1;
  let quote: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (quote !== null) {
      if (ch === quote && args[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) count++;
  }
  return count;
}

const calls = sourceFiles(SRC).flatMap((file) =>
  describeQueryErrorArguments(stripComments(readFileSync(file, 'utf8'))).map((args) => ({
    file: relative(SRC, file),
    args,
  }))
);

describe('describeQueryError names its verb', () => {
  test('there are calls to check — the rule has not gone vacuous', () => {
    expect(calls.length).toBeGreaterThan(0);
  });

  test('no call falls back to the load default', () => {
    const missing = calls.filter((call) => topLevelArgumentCount(call.args) < 3);
    expect(missing.map((call) => `${call.file}: describeQueryError(${call.args})`)).toEqual([]);
  });

  test('the argument splitter is not fooled by a nested comma', () => {
    expect(topLevelArgumentCount("err, t('a.b', { n: 1 })")).toBe(2);
    expect(topLevelArgumentCount("err, t('a.b', { n: 1 }), 'create'")).toBe(3);
  });
});

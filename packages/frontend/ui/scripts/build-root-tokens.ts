/**
 * Derives `src/styles/v3-tokens-root.css` from `src/styles/v3-tokens.css`.
 *
 * The v3 token layer has to ship in two scoping modes: `[data-ui="v3"]` for
 * `apps/frontend/app`, where a v2 sits beside it and must not move, and `:root`
 * for landing / cloud / admin, which have no v2 to protect. The *values* are one
 * design system either way, so they are authored exactly once — in the scoped
 * file — and this script rewrites the selectors for the other mode.
 *
 * CSS cannot express this itself: `@import` cannot be nested inside a rule, so
 * a shared body cannot be parameterised by a selector. The alternatives were a
 * hand-maintained second copy (the drift this exists to prevent) or a private
 * `--v3-*` indirection layer, which only moves the duplication from the values
 * to a mapping list of the same length and makes every token unreadable.
 * `tests/styles/v3-tokens-root.test.ts` re-runs this transform and fails if the
 * committed output disagrees, so the generated file cannot drift silently.
 *
 * Run: `bun run tokens:root` from `packages/frontend/ui`.
 */

import { join } from 'node:path';

const SCOPE = "[data-ui='v3']";

const BANNER = `/**
 * v3 design tokens at \`:root\` — GENERATED, do not edit.
 *
 * Source of truth: \`v3-tokens.css\`. Regenerate with \`bun run tokens:root\`.
 *
 * Identical to that file in every declaration; only the selectors differ. Import
 * this variant from an app that has no second design system to protect, and the
 * whole token layer applies to the document — no wrapper element, no attribute,
 * and overlays portalled to \`document.body\` resolve the same tokens as the tree
 * they were opened from.
 *
 * The comments below are carried over verbatim from the scoped source, so where
 * one says "the v3 scope" or "inside \`[data-ui='v3']\`", read ":root".
 */`;

type Segment = { text: string; isComment: boolean };

/** Splits a selector list on its top-level commas — `:is(a, b)` holds its own. */
function splitTopLevel(selectors: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (const ch of selectors) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

/**
 * `[data-ui='v3']` → `:root`, and anything descending from it loses the
 * ancestor. `.dark [data-ui='v3']` and `.dark[data-ui='v3']` both collapse onto
 * `.dark`, hence the dedupe — the two exist in the source only because the
 * attribute may sit on the shell root or on `<html>`, a distinction `:root`
 * does not have.
 */
function rewriteSelectorList(text: string): string {
  const match = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
  const [, lead = '', core = '', trail = ''] = match ?? [];
  if (core === '' || core.startsWith('@')) return text;

  const rewritten: string[] = [];
  for (const selector of splitTopLevel(core)) {
    if (!selector.includes(SCOPE)) {
      throw new Error(`unscoped selector in v3-tokens.css: ${selector.trim()}`);
    }
    const stripped = selector.split(SCOPE).join('').trim();
    const next = stripped === '' ? ':root' : stripped;
    if (!rewritten.includes(next)) rewritten.push(next);
  }

  const indent = lead.slice(lead.lastIndexOf('\n') + 1);
  return lead + rewritten.join(`,\n${indent}`) + trail;
}

/** Everything after the last comment in a prelude is the selector list. */
function rewritePrelude(segments: Segment[]): string {
  const lastComment = segments.map((s) => s.isComment).lastIndexOf(true);
  const before = segments.slice(0, lastComment + 1);
  if (before.some((s) => !s.isComment && s.text.trim() !== '')) {
    throw new Error('a comment splits a selector list; the transform cannot place it');
  }
  return (
    before.map((s) => s.text).join('') +
    rewriteSelectorList(
      segments
        .slice(lastComment + 1)
        .map((s) => s.text)
        .join('')
    )
  );
}

export function toRootScoped(source: string): string {
  const headerEnd = source.indexOf('*/');
  if (!source.startsWith('/**') || headerEnd === -1) {
    throw new Error('v3-tokens.css must open with its documentation comment');
  }
  const body = BANNER + source.slice(headerEnd + 2);

  let out = '';
  let prelude: Segment[] = [];
  let i = 0;
  while (i < body.length) {
    if (body.startsWith('/*', i)) {
      const end = body.indexOf('*/', i + 2);
      if (end === -1) throw new Error('unterminated comment');
      prelude.push({ text: body.slice(i, end + 2), isComment: true });
      i = end + 2;
      continue;
    }
    const ch = body[i] as string;
    if (ch === '{') {
      out += `${rewritePrelude(prelude)}{`;
      prelude = [];
      i += 1;
      continue;
    }
    if (ch === '}' || ch === ';') {
      out += prelude.map((s) => s.text).join('') + ch;
      prelude = [];
      i += 1;
      continue;
    }
    prelude.push({ text: ch, isComment: false });
    i += 1;
  }
  return out + prelude.map((s) => s.text).join('');
}

export const SCOPED_PATH = join(import.meta.dir, '../src/styles/v3-tokens.css');
export const ROOT_PATH = join(import.meta.dir, '../src/styles/v3-tokens-root.css');

if (import.meta.main) {
  await Bun.write(ROOT_PATH, toRootScoped(await Bun.file(SCOPED_PATH).text()));
  console.log(`wrote ${ROOT_PATH}`);
}

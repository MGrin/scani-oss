// Fails the build when a page whose source contains a Markdown pipe table
// produces HTML with no <table> in it, or a <table> that is not inside a
// scroll region.
//
// This exists because that is exactly what shipped: Astro applies GFM to `.md`
// through an internal flag `@astrojs/mdx` does not inherit, so 15 `.mdx` pages
// rendered every schema and env-var table as a paragraph of `|` characters —
// in production, for as long as the pages existed, with a green build. The
// pipeline is one line of config and nothing else asserted its effect.
//
// Both the GFM switch and the scroll plugin are registered on
// `markdown.processor` (`unified({...})` from `@astrojs/markdown-remark`).
// Nothing about that registration is asserted here on purpose: SC-182 had a
// config Astro accepted without complaint and fifteen pages of `|` characters
// in production. Only the built HTML answers the question this script asks.
//
// It also asserts every built table sits inside a `.table-scroll-viewport`.
// That wrapper is what carries the edge fade, the `tabindex` and the
// accessible name — without it a four-column reference table on a 390px screen
// shows two columns and gives the reader no indication the others exist
// (SC-102). Same reasoning as above: the affordance is one rehype plugin in
// `astro.config.mjs` and nothing else would notice it going missing.
//
// Runs after `astro build` via the docs package.json `build` script, against
// `dist/` rather than the dev server: the dev server and the production build
// resolve integrations separately and only the built output is what readers get.

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const DOCS_ROOT = join(ROOT, 'src', 'content', 'docs');
const DIST_ROOT = join(ROOT, 'dist');

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (entry.name.endsWith('.md') || entry.name.endsWith('.mdx')) {
      out.push(full);
    }
  }
  return out;
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---')) return raw;
  const end = raw.indexOf('\n---', 3);
  return end === -1 ? raw : raw.slice(end + 4);
}

const HEADER_ROW = /^\s*\|.*\|\s*$/;
// `|---|---|`, `| :--- | ---: |`, … — the delimiter row is what makes the
// lines above and below it a table rather than prose that happens to use pipes.
const DELIMITER_ROW = /^\s*\|(?:\s*:?-{1,}:?\s*\|)+\s*$/;

/**
 * Whether the source authors a pipe table outside a fenced code block.
 *
 * Fences are tracked because half these pages document shell and SQL, and a
 * `|` inside a fence is a pipe operator, not a column separator.
 */
export function hasPipeTable(source: string): boolean {
  const lines = stripFrontmatter(source).split('\n');
  let fence: string | null = null;

  for (const [index, line] of lines.entries()) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) fence = marker[0];
      else if (marker[0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;

    const previous = lines[index - 1];
    if (previous !== undefined && DELIMITER_ROW.test(line) && HEADER_ROW.test(previous)) {
      return true;
    }
  }
  return false;
}

/** `concepts/vaults.mdx` → `dist/concepts/vaults/index.html`. */
function outputPath(file: string): string {
  const slug = relative(DOCS_ROOT, file)
    .split(sep)
    .join('/')
    .replace(/\.(md|mdx)$/, '')
    .replace(/(^|\/)index$/, '');
  return join(DIST_ROOT, slug, 'index.html');
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function main(): Promise<void> {
  const files = (await walk(DOCS_ROOT)).sort();
  const failures: string[] = [];
  let checked = 0;
  let wrapped = 0;

  for (const file of files) {
    if (!hasPipeTable(await readFile(file, 'utf8'))) continue;
    checked += 1;

    const output = outputPath(file);
    const html = await readFile(output, 'utf8').catch(() => null);
    const source = relative(ROOT, file);

    if (html === null) {
      failures.push(`${source} — no built page at ${relative(ROOT, output)}`);
      continue;
    }

    const tables = countOccurrences(html, '<table');
    if (tables === 0) {
      failures.push(`${source} — authors a pipe table, built page has no <table>`);
      continue;
    }

    const viewports = countOccurrences(html, 'table-scroll-viewport');
    if (viewports < tables) {
      failures.push(
        `${source} — ${tables} <table>(s) but ${viewports} scroll region(s); an unwrapped table gives a phone reader no sign its off-screen columns exist`
      );
      continue;
    }
    wrapped += tables;
  }

  // A check that finds nothing to check passes for the same reason a broken
  // one does. `checked` only falls to zero if the content root moved or the
  // pipe-table detector stopped matching — either way this script is inert and
  // the pipeline it guards is unobserved again.
  if (checked === 0) {
    console.error(
      `\nNo page under ${relative(ROOT, DOCS_ROOT)} authors a Markdown pipe table.\n` +
        'This check has nothing to assert, so it is not protecting anything.\n'
    );
    process.exit(1);
  }

  if (failures.length > 0) {
    console.error(`\nTable rendering is broken on ${failures.length} of ${checked} pages:\n`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    console.error(
      '\nBoth come off `markdown.processor` in astro.config.mjs: the table itself\n' +
        'from `unified({ gfm })`, the scroll region from `unified({ rehypePlugins })`\n' +
        '(rehype-scrollable-tables.mjs).\n'
    );
    process.exit(1);
  }

  console.log(
    `✓ ${checked} pages author a pipe table; all render a <table>, and all ${wrapped} are inside a scroll region.`
  );
}

await main();

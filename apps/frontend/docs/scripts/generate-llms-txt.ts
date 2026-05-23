// Generates public/llms.txt (compact index per llmstxt.org) and
// public/llms-full.txt (every page's body concatenated) by walking
// src/content/docs.
//
// Runs before `astro build` via the docs package.json `build` script.

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const DOCS_ROOT = join(import.meta.dir, '..', 'src', 'content', 'docs');
const PUBLIC_DIR = join(import.meta.dir, '..', 'public');

interface Page {
  // Slug used in URLs: 'concepts/holdings', 'self-hosting/tier1/production', …
  slug: string;
  title: string;
  description: string;
  body: string;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (entry.name.endsWith('.md') || entry.name.endsWith('.mdx')) {
      out.push(full);
    }
  }
  return out;
}

function parseFrontmatter(raw: string): { title: string; description: string; body: string } {
  // Minimal YAML frontmatter reader. We only need `title:` and `description:`
  // — enough for the index and the page header.
  if (!raw.startsWith('---')) {
    return { title: 'Untitled', description: '', body: raw };
  }
  const end = raw.indexOf('\n---', 3);
  if (end === -1) {
    return { title: 'Untitled', description: '', body: raw };
  }
  const fm = raw.slice(3, end);
  const body = raw.slice(end + 4).replace(/^\n/, '');

  const titleMatch = fm.match(/^title:\s*(.+)$/m);
  const descMatch = fm.match(/^description:\s*(.+)$/m);

  const unquote = (s: string): string => s.trim().replace(/^['"](.*)['"]$/, '$1');

  return {
    title: titleMatch ? unquote(titleMatch[1]) : 'Untitled',
    description: descMatch ? unquote(descMatch[1]) : '',
    body,
  };
}

function fileToSlug(file: string): string {
  const rel = relative(DOCS_ROOT, file).split(sep).join('/');
  return rel.replace(/\.(md|mdx)$/, '').replace(/\/index$/, '');
}

const CLUSTERS: { label: string; prefix: string }[] = [
  { label: 'Start here', prefix: 'start/' },
  { label: 'Concepts', prefix: 'concepts/' },
  { label: 'Design decisions', prefix: 'decisions/' },
  { label: 'Self-hosting', prefix: 'self-hosting/' },
  { label: 'Contributing', prefix: 'contributing/' },
  { label: 'Reference', prefix: 'reference/' },
];

function clusterFor(slug: string): string {
  for (const c of CLUSTERS) {
    if (slug.startsWith(c.prefix)) return c.label;
  }
  return 'Other';
}

function pageUrl(slug: string): string {
  if (slug === 'index' || slug === '') return '/';
  return `/${slug}/`;
}

async function main(): Promise<void> {
  const files = await walk(DOCS_ROOT);
  const pages: Page[] = [];

  for (const file of files) {
    const raw = await readFile(file, 'utf8');
    const { title, description, body } = parseFrontmatter(raw);
    const slug = fileToSlug(file);
    pages.push({ slug, title, description, body });
  }

  pages.sort((a, b) => a.slug.localeCompare(b.slug));

  // ---------- llms.txt ----------
  const lines: string[] = [];
  lines.push('# Scani docs');
  lines.push('');
  lines.push(
    'Self-hostable, open-source portfolio tracker for crypto and traditional assets. Domain model, self-hosting guide, design decisions, and a financial glossary.'
  );
  lines.push('');

  const grouped = new Map<string, Page[]>();
  for (const p of pages) {
    const c = clusterFor(p.slug);
    if (!grouped.has(c)) grouped.set(c, []);
    grouped.get(c)!.push(p);
  }

  // Emit clusters in the declared order, then "Other" if any.
  const orderedLabels = [...CLUSTERS.map((c) => c.label), 'Other'];
  for (const label of orderedLabels) {
    const cluster = grouped.get(label);
    if (!cluster || cluster.length === 0) continue;
    lines.push(`## ${label}`);
    lines.push('');
    for (const p of cluster) {
      const url = pageUrl(p.slug);
      const desc = p.description ? `: ${p.description}` : '';
      lines.push(`- [${p.title}](${url})${desc}`);
    }
    lines.push('');
  }

  // ---------- llms-full.txt ----------
  const fullSections: string[] = [];
  for (const p of pages) {
    const url = pageUrl(p.slug);
    fullSections.push(`# ${p.title}\n\nURL: ${url}\n\n${p.body.trim()}`);
  }

  await mkdir(PUBLIC_DIR, { recursive: true });
  await writeFile(join(PUBLIC_DIR, 'llms.txt'), `${lines.join('\n')}\n`);
  await writeFile(join(PUBLIC_DIR, 'llms-full.txt'), `${fullSections.join('\n\n---\n\n')}\n`);

  console.log(
    `generated ${pages.length} pages → llms.txt + llms-full.txt in ${relative(process.cwd(), PUBLIC_DIR)}`
  );
}

main().catch((err) => {
  console.error('generate-llms-txt failed:', err);
  process.exit(1);
});

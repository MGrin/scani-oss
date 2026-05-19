/**
 * Build-time prerender (browserless). Runs after `vite build`: spins up
 * a Vite dev server in middleware mode, loads `src/entry-server.tsx`
 * through Vite's SSR pipeline, renders every route to static HTML with
 * `react-dom/server`, and writes the result into `dist/<route>/index.html`
 * with route-correct <head> tags — so crawlers and no-JS visitors get
 * fully-rendered pages instead of an empty shell. No headless browser.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'vite';
import { getRouteMeta, renderHeadTags } from '../src/seo/routeMeta';
import { allRoutePaths } from '../src/seo/staticRoutes';

const LANDING_ROOT = resolve(import.meta.dir, '..');
const DIST = join(LANDING_ROOT, 'dist');

interface ServerModule {
  render: (path: string) => Promise<string>;
}

// Flat `.html` files (not `<route>/index.html`): Cloudflare Pages serves
// `dist/alternatives.html` at `/alternatives` with no redirect, whereas a
// directory-index file 308-redirects `/alternatives` → `/alternatives/`.
// Flat files keep the served URLs slash-free, matching the canonical
// tags, sitemap, and internal links.
function outputFile(routePath: string): string {
  if (routePath === '/') return join(DIST, 'index.html');
  return join(DIST, `${routePath.replace(/^\/+/, '')}.html`);
}

// Inlines the built stylesheet into the template so the first paint is
// not blocked on a separate CSS request — the main FCP/LCP lever for a
// prerendered page. The hashed <link> is replaced by a <style> block.
async function inlineStylesheets(html: string): Promise<string> {
  let out = html;
  const linkRe = /<link[^>]*rel="stylesheet"[^>]*href="(\/assets\/[^"]+\.css)"[^>]*>/g;
  for (const match of html.matchAll(linkRe)) {
    const href = match[1];
    if (!href) continue;
    const css = await readFile(join(DIST, href.replace(/^\//, '')), 'utf8');
    out = out.replace(match[0], `<style>${css}</style>`);
  }
  return out;
}

async function main(): Promise<void> {
  const rawTemplate = await readFile(join(DIST, 'index.html'), 'utf8');
  if (!rawTemplate.includes('<div id="root"></div>')) {
    throw new Error('dist/index.html has no empty <div id="root"> to inject into');
  }
  const template = await inlineStylesheets(rawTemplate);

  const vite = await createServer({
    root: LANDING_ROOT,
    appType: 'custom',
    logLevel: 'warn',
    server: { middlewareMode: true },
    // SSR-only usage — skip the client-side dependency optimizer so
    // `vite.close()` doesn't log a spurious "build was canceled".
    optimizeDeps: { noDiscovery: true },
    // Transform the workspace packages through Vite's SSR pipeline so
    // their `import.meta.env` / JSX resolve correctly server-side.
    ssr: { noExternal: [/^@scani\//] },
  });

  const snapshots: { file: string; html: string }[] = [];
  try {
    const mod = (await vite.ssrLoadModule('/src/entry-server.tsx')) as ServerModule;
    for (const routePath of allRoutePaths()) {
      const body = await mod.render(routePath);
      if (!body.includes('<h1')) {
        throw new Error(`Prerender ${routePath}: rendered body has no <h1>`);
      }
      const meta = getRouteMeta(routePath);
      const html = template
        // Drop HTML comments first so the title/description strip below
        // can't match tag-like text inside a comment.
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<title>[\s\S]*?<\/title>\s*/i, '')
        .replace(/<meta\s+name="description"[^>]*>\s*/i, '')
        .replace('</head>', `  ${renderHeadTags(meta)}\n  </head>`)
        .replace('<div id="root"></div>', `<div id="root">${body}</div>`);
      snapshots.push({ file: outputFile(routePath), html });
      console.log(`  prerendered ${routePath}  ·  ${meta.title}`);
    }
  } finally {
    await vite.close();
  }

  for (const { file, html } of snapshots) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, html);
  }
  console.log(`Prerendered ${snapshots.length} route(s).`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

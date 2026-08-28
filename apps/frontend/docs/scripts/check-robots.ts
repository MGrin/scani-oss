// Fails the build when `robots.txt` points a crawler at a sitemap the build
// does not actually emit, or at a different host from the one `site` declares.
//
// This exists because the filename is not the obvious one and nothing else
// would notice. Starlight registers `@astrojs/sitemap` itself, and that
// integration emits `sitemap-index.xml` plus `sitemap-0.xml` — there is no
// `sitemap.xml`. Writing the obvious name produces a `robots.txt` that serves
// 200, parses, validates, and points every crawler at a 404. On this host that
// 404 returns a 12904-byte HTML page, so even a fetch that checks the body
// length reads as success; only the status code discriminates.
//
// It runs against `dist/` after `astro build`, not against `public/`, for the
// same reason `check-tables.ts` does: `public/robots.txt` being correct says
// nothing about what the build emitted beside it. The question is whether the
// target exists in the same output the reader is served.
//
// It does NOT assert that the sitemap has any particular contents. That is
// `@astrojs/sitemap`'s job and duplicating it here would be a second check
// that fails for the first one's reasons.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const DIST_ROOT = join(ROOT, 'dist');

/** A `Sitemap:` directive, as parsed out of a robots.txt. */
interface SitemapDirective {
  raw: string;
  url: URL | null;
}

export function parseSitemapDirectives(robotsText: string): SitemapDirective[] {
  const out: SitemapDirective[] = [];
  for (const line of robotsText.split('\n')) {
    const match = line.match(/^\s*sitemap\s*:\s*(\S+)\s*$/i);
    if (!match) continue;
    const raw = match[1] as string;
    let url: URL | null = null;
    try {
      url = new URL(raw);
    } catch {
      url = null;
    }
    out.push({ raw, url });
  }
  return out;
}

/**
 * The whole check, as a pure function over what was read.
 *
 * Split out from `main` so it can be exercised against inputs that are
 * supposed to FAIL. A build-time script that only ever runs against a healthy
 * tree has never demonstrated it can fail, and a check that cannot fail is
 * indistinguishable from one that is not running.
 */
export function checkRobots(input: {
  /** `null` when `dist/robots.txt` does not exist at all. */
  robotsText: string | null;
  /** The `site` from `astro.config.mjs`, e.g. `https://docs.scani.xyz`. */
  site: string;
  /** Paths present in `dist/`, relative and slash-separated, no leading `/`. */
  distPaths: ReadonlySet<string>;
}): string[] {
  const { robotsText, site, distPaths } = input;
  const errors: string[] = [];

  if (robotsText === null) {
    errors.push(
      'dist/robots.txt is missing. Crawlers fall back to no directives and the sitemap is never announced — add apps/frontend/docs/public/robots.txt.'
    );
    return errors;
  }

  const directives = parseSitemapDirectives(robotsText);
  if (directives.length === 0) {
    errors.push(
      'robots.txt declares no `Sitemap:` line, so nothing announces the sitemap the build emits.'
    );
    return errors;
  }

  let siteOrigin: string;
  try {
    siteOrigin = new URL(site).origin;
  } catch {
    errors.push(`\`site\` in astro.config.mjs is not a URL: ${JSON.stringify(site)}`);
    return errors;
  }

  for (const { raw, url } of directives) {
    if (url === null) {
      errors.push(
        `\`Sitemap: ${raw}\` is not an absolute URL. robots.txt requires one — a relative path is ignored rather than resolved.`
      );
      continue;
    }
    if (url.origin !== siteOrigin) {
      errors.push(
        `\`Sitemap: ${raw}\` points at ${url.origin}, but \`site\` is ${siteOrigin}. A cross-host sitemap is discarded unless that host is verified separately.`
      );
      continue;
    }
    const path = url.pathname.replace(/^\//, '');
    if (!distPaths.has(path)) {
      const emitted = [...distPaths].filter((p) => p.includes('sitemap')).sort();
      errors.push(
        `\`Sitemap: ${raw}\` names ${url.pathname}, which the build does not emit. ` +
          (emitted.length > 0
            ? `It emits: ${emitted.map((p) => `/${p}`).join(', ')}.`
            : 'It emits no sitemap at all.')
      );
    }
  }

  return errors;
}

async function walkRelative(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await walkRelative(join(dir, entry.name), rel)));
    } else {
      out.push(rel);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const { default: config } = await import('../astro.config.mjs');
  const site = (config as { site?: string }).site;
  if (!site) {
    console.error(
      'check-robots: `site` is unset in astro.config.mjs. @astrojs/sitemap emits nothing without it, so robots.txt would announce a sitemap that does not exist.'
    );
    process.exit(1);
  }

  let robotsText: string | null = null;
  try {
    robotsText = await readFile(join(DIST_ROOT, 'robots.txt'), 'utf8');
  } catch {
    robotsText = null;
  }

  const distPaths = new Set(await walkRelative(DIST_ROOT));
  const errors = checkRobots({ robotsText, site, distPaths });

  if (errors.length > 0) {
    console.error(`check-robots: ${errors.length} problem(s)`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  const announced = parseSitemapDirectives(robotsText ?? '').map((d) => d.raw);
  console.log(
    `check-robots: ok — robots.txt announces ${announced.length} sitemap(s), all emitted: ${announced.join(', ')}`
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('check-robots failed:', err);
    process.exit(1);
  });
}

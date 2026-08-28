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
  /**
   * The origin the build actually emitted, read off the first `<loc>` in
   * `sitemap-index.xml` rather than out of `astro.config.mjs`.
   *
   * `@astrojs/sitemap` derives those URLs from `site`, so this is the same
   * value one step later — and one step closer to what is served. Importing
   * the config to read `site` would also pull Starlight's whole integration
   * graph into this file's type program, for one string.
   *
   * `null` when the build emitted no sitemap to read it from.
   */
  emittedOrigin: string | null;
  /** Paths present in `dist/`, relative and slash-separated, no leading `/`. */
  distPaths: ReadonlySet<string>;
}): string[] {
  const { robotsText, emittedOrigin, distPaths } = input;
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

  if (emittedOrigin === null) {
    errors.push('robots.txt declares a sitemap but the build emitted none to compare it against.');
    return errors;
  }

  for (const { raw, url } of directives) {
    if (url === null) {
      errors.push(
        `\`Sitemap: ${raw}\` is not an absolute URL. robots.txt requires one — a relative path is ignored rather than resolved.`
      );
      continue;
    }
    if (url.origin !== emittedOrigin) {
      errors.push(
        `\`Sitemap: ${raw}\` points at ${url.origin}, but the build emitted ${emittedOrigin}. A cross-host sitemap is discarded unless that host is verified separately.`
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

/** The origin `@astrojs/sitemap` actually wrote, off the first `<loc>`. */
export function originFromSitemapIndex(xml: string): string | null {
  const loc = xml.match(/<loc>\s*([^<\s]+)\s*<\/loc>/);
  if (!loc) return null;
  try {
    return new URL(loc[1] as string).origin;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  let robotsText: string | null = null;
  try {
    robotsText = await readFile(join(DIST_ROOT, 'robots.txt'), 'utf8');
  } catch {
    robotsText = null;
  }

  let emittedOrigin: string | null = null;
  try {
    emittedOrigin = originFromSitemapIndex(
      await readFile(join(DIST_ROOT, 'sitemap-index.xml'), 'utf8')
    );
  } catch {
    emittedOrigin = null;
  }

  const distPaths = new Set(await walkRelative(DIST_ROOT));
  const errors = checkRobots({ robotsText, emittedOrigin, distPaths });

  if (errors.length > 0) {
    console.error(`check-robots: ${errors.length} problem(s)`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  const announced = parseSitemapDirectives(robotsText ?? '').map((d) => d.raw);
  console.log(
    `check-robots: ok — robots.txt announces ${announced.length} sitemap(s) on ${emittedOrigin}, all emitted: ${announced.join(', ')}`
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('check-robots failed:', err);
    process.exit(1);
  });
}

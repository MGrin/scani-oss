/**
 * Build-time sitemap generator. Writes `dist/sitemap.xml` from the same
 * route list the router and prerender script use, so the sitemap can
 * never drift out of sync with the pages that actually ship.
 */

import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { absoluteUrl } from '../src/seo/siteMeta';
import { allRoutePaths, routePriority } from '../src/seo/staticRoutes';

const DIST = resolve(import.meta.dir, '..', 'dist');

async function main(): Promise<void> {
  const lastmod = new Date().toISOString().slice(0, 10);
  const paths = allRoutePaths();

  const urls = paths
    .map((path) =>
      [
        '  <url>',
        `    <loc>${absoluteUrl(path)}</loc>`,
        `    <lastmod>${lastmod}</lastmod>`,
        '    <changefreq>weekly</changefreq>',
        `    <priority>${routePriority(path).toFixed(1)}</priority>`,
        '  </url>',
      ].join('\n')
    )
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;

  await writeFile(join(DIST, 'sitemap.xml'), xml);
  console.log(`Wrote sitemap.xml with ${paths.length} URL(s).`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

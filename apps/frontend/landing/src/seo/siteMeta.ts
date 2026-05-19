// Single source of truth for site-wide SEO constants. Imported by the
// React head manager and (indirectly, via staticRoutes) by the
// build-time prerender + sitemap scripts.

export const SITE_URL = 'https://scani.xyz';

export const SITE_NAME = 'Scani';

/** Raster OG image — Facebook's crawler cannot render SVG. */
export const DEFAULT_OG_IMAGE = `${SITE_URL}/og-image.png`;

export const GITHUB_URL = 'https://github.com/MGrin/scani';

export const SUPPORT_EMAIL = 'support@scani.xyz';

/** Joins a route path onto the site origin, always producing an absolute URL. */
export function absoluteUrl(path: string): string {
  if (path === '/' || path === '') return `${SITE_URL}/`;
  return `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

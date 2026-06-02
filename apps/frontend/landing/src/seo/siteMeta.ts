// Single source of truth for site-wide SEO constants. Imported by the
// React head manager and (indirectly, via staticRoutes) by the
// build-time prerender + sitemap scripts.

export const SITE_URL = 'https://scani.xyz';

export const SITE_NAME = 'Scani';

/** Raster OG image — Facebook's crawler cannot render SVG. */
export const DEFAULT_OG_IMAGE = `${SITE_URL}/og-image.png`;

export const GITHUB_URL = 'https://github.com/MGrin/scani-oss';

export const DOCS_URL = 'https://docs.scani.xyz';

export const SUPPORT_EMAIL = 'support@scani.xyz';

export const TWITTER_HANDLE = '@scani_xyz';

export const TWITTER_URL = 'https://x.com/scani_xyz';

export const BLUESKY_HANDLE = '@scani.xyz';

export const BLUESKY_URL = 'https://bsky.app/profile/scani.xyz';

/** Joins a route path onto the site origin, always producing an absolute URL. */
export function absoluteUrl(path: string): string {
  if (path === '/' || path === '') return `${SITE_URL}/`;
  return `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

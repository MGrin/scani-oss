// Plain route lists shared by the React router, the prerender script,
// and the sitemap generator. No JSX — safe to import from Bun scripts.

import { COMPARISON_SLUGS } from '../data/comparisons';

/** Fixed (non-parameterised) routes. */
export const STATIC_ROUTE_PATHS: readonly string[] = ['/', '/contact', '/alternatives'];

/** Every concrete URL path the site serves, comparison pages expanded. */
export function allRoutePaths(): string[] {
  return [...STATIC_ROUTE_PATHS, ...COMPARISON_SLUGS.map((slug) => `/vs/${slug}`)];
}

/** Sitemap crawl priority per path — home highest, comparisons mid. */
export function routePriority(path: string): number {
  if (path === '/') return 1.0;
  if (path === '/alternatives') return 0.8;
  if (path.startsWith('/vs/')) return 0.7;
  return 0.5;
}

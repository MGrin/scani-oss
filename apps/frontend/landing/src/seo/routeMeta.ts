// Per-route head metadata. Pure data + string helpers (no React, no
// `import.meta.env`) so the build-time prerender script can import it
// directly and inject route-correct <head> tags into each page.

import { getComparison } from '../data/comparisons';
import { QAS } from '../data/faq';
import {
  breadcrumbJsonLd,
  contactPointOrganizationJsonLd,
  faqPageJsonLd,
  type JsonLd,
  organizationJsonLd,
  softwareApplicationJsonLd,
  websiteJsonLd,
} from './jsonLd';
import { absoluteUrl, DEFAULT_OG_IMAGE, SITE_NAME, SUPPORT_EMAIL } from './siteMeta';

export interface RouteMeta {
  title: string;
  description: string;
  canonicalPath: string;
  noindex: boolean;
  jsonLd: JsonLd[];
}

const HOME: RouteMeta = {
  title: 'Scani — One dashboard for every asset, every chain',
  description:
    'Scani consolidates banks, brokerages, exchanges, and on-chain wallets into one real-time portfolio. Self-host, use the cloud API, or sign up for the managed app.',
  canonicalPath: '/',
  noindex: false,
  jsonLd: [organizationJsonLd(), websiteJsonLd(), softwareApplicationJsonLd(), faqPageJsonLd(QAS)],
};

/** Resolves the head metadata for a concrete route path. */
export function getRouteMeta(path: string): RouteMeta {
  if (path === '/contact') {
    return {
      title: 'Contact Scani — talk to the team',
      description:
        'Questions about a plan, a stuck integration, an idea, or a security report — reach the Scani team and a human replies, usually within one business day.',
      canonicalPath: '/contact',
      noindex: false,
      jsonLd: [contactPointOrganizationJsonLd(SUPPORT_EMAIL)],
    };
  }

  if (path === '/alternatives') {
    return {
      title: 'Portfolio tracker alternatives — open-source & self-hosted | Scani',
      description:
        'See how Scani compares to Ghostfolio, rotki, Kubera, CoinStats, Maybe Finance, and MyFinanceTools across banks, brokerages, crypto exchanges, and on-chain wallets.',
      canonicalPath: '/alternatives',
      noindex: false,
      jsonLd: [
        websiteJsonLd(),
        breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'Alternatives', path: '/alternatives' },
        ]),
      ],
    };
  }

  if (path.startsWith('/vs/')) {
    const comparison = getComparison(path.slice('/vs/'.length));
    if (comparison) {
      return {
        title: comparison.metaTitle,
        description: comparison.metaDescription,
        canonicalPath: path,
        noindex: false,
        jsonLd: [
          breadcrumbJsonLd([
            { name: 'Home', path: '/' },
            { name: 'Alternatives', path: '/alternatives' },
            { name: `Scani vs ${comparison.competitor}`, path },
          ]),
          softwareApplicationJsonLd(),
        ],
      };
    }
  }

  return HOME;
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

/** Serialises a RouteMeta into the <head> tag block for that route. */
export function renderHeadTags(meta: RouteMeta): string {
  const canonical = absoluteUrl(meta.canonicalPath);
  const description = escapeAttr(meta.description);
  const titleAttr = escapeAttr(meta.title);

  const tags = [
    `<title>${escapeText(meta.title)}</title>`,
    `<meta name="description" content="${description}" />`,
    `<link rel="canonical" href="${canonical}" />`,
  ];
  if (meta.noindex) tags.push('<meta name="robots" content="noindex, follow" />');
  tags.push(
    '<meta property="og:type" content="website" />',
    `<meta property="og:url" content="${canonical}" />`,
    `<meta property="og:title" content="${titleAttr}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:image" content="${DEFAULT_OG_IMAGE}" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:title" content="${titleAttr}" />`,
    `<meta name="twitter:description" content="${description}" />`,
    `<meta name="twitter:image" content="${DEFAULT_OG_IMAGE}" />`
  );
  for (const block of meta.jsonLd) {
    // Escape `<` so a string value can never break out of the <script>.
    const json = JSON.stringify(block).replace(/</g, '\\u003c');
    tags.push(`<script type="application/ld+json">${json}</script>`);
  }
  return tags.join('\n    ');
}

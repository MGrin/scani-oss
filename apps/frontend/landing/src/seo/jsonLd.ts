// schema.org JSON-LD builders. Each returns a plain object that the
// <Head> component serialises into a <script type="application/ld+json">.

import type { QA } from '../data/faq';
import { absoluteUrl, DEFAULT_OG_IMAGE, GITHUB_URL, SITE_NAME, SITE_URL } from './siteMeta';

export type JsonLd = Record<string, unknown>;

export function organizationJsonLd(): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: SITE_NAME,
    url: SITE_URL,
    logo: DEFAULT_OG_IMAGE,
    sameAs: [GITHUB_URL],
  };
}

export function websiteJsonLd(): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE_NAME,
    url: SITE_URL,
  };
}

export function softwareApplicationJsonLd(): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: SITE_NAME,
    applicationCategory: 'FinanceApplication',
    operatingSystem: 'Web',
    url: SITE_URL,
    description:
      'Scani consolidates banks, brokerages, exchanges, and on-chain wallets into one real-time portfolio — self-hosted, as a managed SaaS, or via a metered API.',
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
      description: 'Free during beta across every tier.',
    },
  };
}

export function faqPageJsonLd(qas: ReadonlyArray<QA>): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: qas.map((qa) => ({
      '@type': 'Question',
      name: qa.q,
      acceptedAnswer: { '@type': 'Answer', text: qa.a },
    })),
  };
}

export function breadcrumbJsonLd(items: ReadonlyArray<{ name: string; path: string }>): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: absoluteUrl(item.path),
    })),
  };
}

export function contactPointOrganizationJsonLd(email: string): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: SITE_NAME,
    url: SITE_URL,
    logo: DEFAULT_OG_IMAGE,
    sameAs: [GITHUB_URL],
    contactPoint: {
      '@type': 'ContactPoint',
      contactType: 'customer support',
      email,
      url: absoluteUrl('/contact'),
    },
  };
}

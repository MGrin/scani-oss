// @ts-check

import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  site: 'https://docs.scani.xyz',
  integrations: [
    starlight({
      title: 'Scani docs',
      description:
        'Self-hostable, open-source portfolio tracker for crypto and traditional assets. Domain model, self-hosting guide, design decisions, and a full financial glossary.',
      logo: {
        light: './src/assets/logo-light.svg',
        dark: './src/assets/logo-dark.svg',
      },
      customCss: ['./src/styles/custom.css'],
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/MGrin/scani-oss',
        },
        {
          icon: 'blueSky',
          label: 'Bluesky',
          href: 'https://bsky.app/profile/scani.xyz',
        },
        {
          icon: 'x.com',
          label: 'X',
          href: 'https://x.com/scani_xyz',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/MGrin/scani-oss/edit/main/apps/frontend/docs/',
      },
      lastUpdated: true,
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Welcome', slug: 'index' },
            { label: 'What is Scani', slug: 'start/what-is-scani' },
            { label: 'Quickstart', slug: 'start/quickstart' },
            { label: 'How to read these docs', slug: 'start/how-to-read' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'Mental model', slug: 'concepts/mental-model' },
            { label: 'Holdings', slug: 'concepts/holdings' },
            { label: 'Accounts & institutions', slug: 'concepts/accounts' },
            { label: 'Tokens & market segments', slug: 'concepts/tokens' },
            { label: 'Transactions (the ledger)', slug: 'concepts/transactions' },
            { label: 'Transfers & swaps', slug: 'concepts/transfers' },
            { label: 'Observations & coverage', slug: 'concepts/observations' },
            { label: 'Balance reconstruction', slug: 'concepts/balance-reconstruction' },
            { label: 'Pricing & the price graph', slug: 'concepts/pricing' },
            { label: 'Portfolio value rollup', slug: 'concepts/rollup' },
            { label: 'Vaults', slug: 'concepts/vaults' },
            { label: 'Groups', slug: 'concepts/groups' },
            { label: 'APY & yield', slug: 'concepts/apy' },
            { label: 'Manual assets', slug: 'concepts/manual-assets' },
            { label: 'Token identity & enrichment', slug: 'concepts/token-identity' },
          ],
        },
        {
          label: 'Design decisions',
          items: [
            { label: 'Why an append-only ledger', slug: 'decisions/append-only-ledger' },
            { label: 'Why no USD canonicalisation', slug: 'decisions/no-usd-canonical' },
            {
              label: 'Why manual data is a synthetic institution',
              slug: 'decisions/manual-institution',
            },
            {
              label: 'Why transfer linking runs nightly',
              slug: 'decisions/nightly-transfer-linking',
            },
            {
              label: 'Why the holding-inclusion rule lives twice',
              slug: 'decisions/holding-inclusion-rule',
            },
            { label: 'Why the three-tier deployment model', slug: 'decisions/three-tier-model' },
            {
              label: 'Why class-field DI, not constructor injection',
              slug: 'decisions/class-field-di',
            },
            {
              label: 'Why BullMQ + Postgres advisory locks',
              slug: 'decisions/bullmq-advisory-locks',
            },
          ],
        },
        {
          label: 'Self-hosting',
          items: [
            { label: 'Tier model', slug: 'self-hosting/tier-model' },
            {
              label: 'Tier 1 — fully self-hosted',
              items: [
                { label: 'Local development stack', slug: 'self-hosting/tier1/local-dev' },
                { label: 'Production with docker-compose', slug: 'self-hosting/tier1/production' },
                {
                  label: 'Required environment variables',
                  slug: 'self-hosting/tier1/required-env',
                },
                { label: 'Optional integration keys', slug: 'self-hosting/tier1/optional-keys' },
                { label: 'TLS & reverse proxy', slug: 'self-hosting/tier1/tls-reverse-proxy' },
                {
                  label: 'Managed Postgres / Redis / S3',
                  slug: 'self-hosting/tier1/managed-services',
                },
                { label: 'Backup & restore', slug: 'self-hosting/tier1/backup-restore' },
                { label: 'Upgrades & version pinning', slug: 'self-hosting/tier1/upgrades' },
                { label: 'Observability', slug: 'self-hosting/tier1/observability' },
                { label: 'Troubleshooting', slug: 'self-hosting/tier1/troubleshooting' },
              ],
            },
            {
              label: 'Tier 2 — semi-managed',
              items: [
                { label: 'Overview', slug: 'self-hosting/tier2/overview' },
                {
                  label: 'Pointing api + worker at a hosted endpoint',
                  slug: 'self-hosting/tier2/wiring',
                },
                { label: 'What stays on your side', slug: 'self-hosting/tier2/user-creds' },
                { label: 'Migrating Tier 1 → Tier 2', slug: 'self-hosting/tier2/migration' },
              ],
            },
            { label: 'Tier 3 — fully managed', slug: 'self-hosting/tier3' },
          ],
        },
        {
          label: 'Contributing',
          items: [
            { label: 'How to contribute', slug: 'contributing/how-to' },
            { label: 'Engineering conventions', slug: 'contributing/conventions' },
            { label: 'Dependency injection pattern', slug: 'contributing/di-pattern' },
            { label: 'Testing patterns', slug: 'contributing/testing' },
            { label: 'Adding a provider', slug: 'contributing/adding-a-provider' },
            { label: 'Adding a scheduled job', slug: 'contributing/adding-a-job' },
            { label: 'Adding a database migration', slug: 'contributing/adding-a-migration' },
            { label: 'Release flow', slug: 'contributing/release-flow' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Glossary', slug: 'reference/glossary' },
            { label: 'Environment variables', slug: 'reference/environment' },
            { label: 'Repo layout', slug: 'reference/repo-layout' },
            { label: 'Database schema', slug: 'reference/database-schema' },
            { label: 'tRPC route catalogue', slug: 'reference/trpc-routes' },
            { label: 'Job catalogue', slug: 'reference/jobs' },
            { label: 'Provider matrix', slug: 'reference/provider-matrix' },
            { label: 'LLM-friendly index', slug: 'reference/llms' },
          ],
        },
      ],
    }),
  ],
});

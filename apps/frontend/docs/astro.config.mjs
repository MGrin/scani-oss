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
        'Self-hostable, open-source portfolio tracker for crypto and traditional assets.',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/MGrin/scani-oss',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/MGrin/scani-oss/edit/main/apps/frontend/docs/',
      },
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Overview', slug: 'overview' },
            { label: 'Quickstart', slug: 'quickstart' },
          ],
        },
        {
          label: 'Self-hosting',
          items: [
            { label: 'Tier model', slug: 'self-hosting/tier-model' },
            { label: 'Environment variables', slug: 'self-hosting/environment' },
            { label: 'Production', slug: 'self-hosting/production' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'Architecture', slug: 'concepts/architecture' },
            { label: 'Provider integrations', slug: 'concepts/integrations' },
            { label: 'Privacy & telemetry', slug: 'concepts/privacy' },
          ],
        },
        {
          label: 'Contributing',
          items: [
            { label: 'How to contribute', slug: 'contributing/how-to' },
            { label: 'Engineering conventions', slug: 'contributing/conventions' },
          ],
        },
        {
          label: 'Reference',
          items: [{ autogenerate: { directory: 'reference' } }],
        },
      ],
    }),
  ],
});

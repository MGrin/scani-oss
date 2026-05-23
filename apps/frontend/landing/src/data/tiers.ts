import { Cloud, Server, Sparkles } from 'lucide-react';

export interface Tier {
  Icon: typeof Cloud;
  name: string;
  who: string;
  price: string;
  beta: string | null;
  features: string[];
  cta: { label: string; href: string; primary?: boolean };
}

export const TIERS: ReadonlyArray<Tier> = [
  {
    Icon: Server,
    name: 'Self-host',
    who: 'Engineers, compliance-first orgs, contributors.',
    price: 'Free forever',
    beta: null,
    features: [
      'MIT-licensed — runs on your laptop, your VPS, or any cloud',
      'Bring your own database, cache, and provider API keys',
      'Every integration runs locally — no Scani server in the loop',
      'Pre-built multi-arch Docker images on every push to main',
    ],
    cta: { label: 'View on GitHub', href: 'https://github.com/MGrin/scani-oss' },
  },
  {
    Icon: Cloud,
    name: 'Cloud API',
    who: 'Builders integrating Scani into their own stack.',
    price: 'Usage-based',
    beta: '1 year free for beta-preview signups',
    features: [
      'One API key per tenant — no shared secrets',
      'Type-safe endpoints for every asset class we cover',
      'Open spec + interactive playground at /docs',
      'Hard cost ceiling and per-key quotas — no surprise bills',
    ],
    cta: { label: 'Get an API key', href: 'https://cloud.scani.xyz', primary: true },
  },
  {
    Icon: Sparkles,
    name: 'Managed SaaS',
    who: "Individuals who'd rather not run infrastructure.",
    price: 'Subscription',
    beta: '1 year free for beta-preview signups',
    features: [
      "Sign up and you're done — no infra, no setup",
      'Always-current balances and prices, no manual refresh',
      'AI parses screenshots of any account, anywhere',
      'We run the security, the backups, the uptime',
    ],
    cta: { label: 'Open the app', href: 'https://app.scani.xyz', primary: true },
  },
];

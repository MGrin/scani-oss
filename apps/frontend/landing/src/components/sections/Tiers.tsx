import { Check, Cloud, Server, Sparkles } from 'lucide-react';
import { useRevealOnScroll } from '../../hooks/useRevealOnScroll';

interface Tier {
  Icon: typeof Cloud;
  name: string;
  who: string;
  price: string;
  beta: string | null;
  features: string[];
  cta: { label: string; href: string; primary?: boolean };
}

const TIERS: ReadonlyArray<Tier> = [
  {
    Icon: Server,
    name: 'Self-host',
    who: 'Engineers, compliance-first orgs, contributors.',
    price: 'Free forever',
    beta: null,
    features: [
      'Open-source — runs on your laptop, your VPS, or any cloud',
      'Bring your own database, cache, and provider API keys',
      'Every integration runs locally — no Scani server in the loop',
      'Source under a permissive license (work in progress)',
    ],
    cta: { label: 'Notify me at launch', href: '#beta' },
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

export function Tiers() {
  const ref = useRevealOnScroll<HTMLElement>();
  return (
    <section
      ref={ref}
      id="tiers"
      data-reveal="section"
      className="border-b border-border/60 bg-background py-12 sm:py-20 lg:py-28"
    >
      <div className="mx-auto max-w-6xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Three tiers, one codebase
          </p>
          <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            Run it yours, or use ours.
          </h2>
          <p className="mt-4 text-balance text-muted-foreground">
            The exact same source ships to every tier. Pick the deployment shape that matches your
            trust model and ops budget.
          </p>
        </div>
        <div className="mt-14 grid gap-6 lg:grid-cols-3">
          {TIERS.map((tier) => (
            <div
              key={tier.name}
              data-reveal="lift"
              className="flex flex-col rounded-xl border border-border bg-card p-6 hover:border-border/80"
            >
              <div className="flex items-center gap-2">
                <tier.Icon className="h-5 w-5 text-foreground" />
                <h3 className="font-semibold">{tier.name}</h3>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{tier.who}</p>
              <div className="mt-6">
                <div className="text-2xl font-semibold">{tier.price}</div>
                {tier.beta && (
                  <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
                    {tier.beta}
                  </div>
                )}
              </div>
              <ul className="mt-6 flex-1 space-y-2 text-sm">
                {tier.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-muted-foreground">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-foreground" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <a
                href={tier.cta.href}
                target={tier.cta.href.startsWith('http') ? '_blank' : undefined}
                rel={tier.cta.href.startsWith('http') ? 'noreferrer noopener' : undefined}
                className={`mt-6 inline-flex h-10 items-center justify-center rounded-md text-sm font-medium transition ${
                  tier.cta.primary
                    ? 'bg-foreground text-background hover:opacity-90'
                    : 'border border-border bg-background text-foreground hover:bg-accent'
                }`}
              >
                {tier.cta.label}
              </a>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

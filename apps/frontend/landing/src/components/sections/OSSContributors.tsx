import { ArrowRight, Bug, GitPullRequest, Plug } from 'lucide-react';
import { useRevealOnScroll } from '../../hooks/useRevealOnScroll';

const REWARD_TYPES = [
  {
    Icon: Bug,
    title: 'Bug fixes that hold up in prod',
    body: 'Real-world repros, regression tests, no smell.',
  },
  {
    Icon: Plug,
    title: 'New integrations',
    body: 'A new bank / broker / exchange / chain wired into the provider registry.',
  },
  {
    Icon: GitPullRequest,
    title: 'Integration improvements',
    body: 'Better reliability, more coverage, or fewer rate-limit incidents on an existing provider.',
  },
];

export function OSSContributors() {
  const ref = useRevealOnScroll<HTMLElement>();
  return (
    <section
      ref={ref}
      data-reveal="section"
      className="border-b border-border/60 bg-background py-12 sm:py-20 lg:py-28"
    >
      <div className="mx-auto max-w-4xl px-6">
        <div className="text-center">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            For contributors
          </p>
          <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            Land a real PR. Get the paid tiers, free, forever.
          </h2>
          <p className="mt-4 text-balance text-muted-foreground">
            We'll be opening the source under a permissive license shortly. Anyone whose merged
            contribution shows up in the kinds of work below gets free-forever access to every paid
            tier — no deprecation, no clawback.
          </p>
        </div>

        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          {REWARD_TYPES.map(({ Icon, title, body }) => (
            <div key={title} className="rounded-xl border border-border bg-card p-5">
              <Icon className="h-5 w-5 text-foreground" />
              <h3 className="mt-3 text-sm font-medium">{title}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{body}</p>
            </div>
          ))}
        </div>

        <div className="mt-10 rounded-xl border border-dashed border-border bg-card/50 p-5 text-sm text-muted-foreground">
          <p>
            <strong className="text-foreground">Heads up:</strong> the source isn't public yet.
            We're getting the code ready to publish under a permissive OSS license. Once that ships
            you'll be able to read it, fork it, and contribute — and the free-forever-access offer
            applies to every significant contribution from that moment on.
          </p>
        </div>

        <div className="mt-8 flex justify-center">
          <a
            href="#beta"
            className="inline-flex h-11 items-center gap-2 rounded-md border border-border bg-card px-5 text-sm font-medium transition-colors hover:bg-accent"
          >
            Notify me when it's out
            <ArrowRight className="h-4 w-4" />
          </a>
        </div>
      </div>
    </section>
  );
}

import { ArrowRight } from 'lucide-react';
import { BetaPromise } from '../components/sections/BetaPromise';
import { COMPARISONS } from '../data/comparisons';

export function AlternativesPage() {
  return (
    <main>
      <section className="relative isolate overflow-hidden border-b border-border/60 bg-background">
        <div className="bg-grid-fade absolute inset-0 -z-10" aria-hidden="true" />
        <div className="mx-auto max-w-3xl px-6 pt-14 pb-12 text-center sm:pt-20 sm:pb-16">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Comparisons
          </p>
          <h1 className="mt-3 text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
            Open-source &amp; self-hosted portfolio tracker alternatives
          </h1>
          <p className="mt-4 text-balance text-lg text-muted-foreground">
            Most trackers cover one slice — crypto, or stocks, or budgeting. Scani consolidates
            banks, brokerages, exchanges, and on-chain wallets into one real-time portfolio. Here's
            how it stacks up against the tools people compare it to.
          </p>
        </div>
      </section>

      <section className="border-b border-border/60 bg-background py-12 sm:py-20">
        <div className="mx-auto max-w-5xl px-6">
          <div className="grid gap-6 sm:grid-cols-2">
            {COMPARISONS.map((comparison) => (
              <a
                key={comparison.slug}
                href={`/vs/${comparison.slug}`}
                className="group flex flex-col rounded-xl border border-border bg-card p-6 transition-colors hover:border-border/80"
              >
                <h2 className="font-semibold">Scani vs {comparison.competitor}</h2>
                <p className="mt-2 flex-1 text-sm text-muted-foreground">{comparison.tagline}</p>
                <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
                  Read comparison
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </span>
              </a>
            ))}
          </div>
        </div>
      </section>

      <BetaPromise />
    </main>
  );
}

import { ArrowRight } from 'lucide-react';
import type { Comparison } from '../../data/comparisons';

export function ComparisonHero({ comparison }: { comparison: Comparison }) {
  return (
    <section className="relative isolate overflow-hidden border-b border-border/60 bg-background">
      <div className="bg-grid-fade absolute inset-0 -z-10" aria-hidden="true" />
      <div className="mx-auto max-w-3xl px-6 pt-14 pb-12 sm:pt-20 sm:pb-16">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Comparison
        </p>
        <h1 className="mt-3 text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
          {comparison.heading}
        </h1>
        <p className="mt-4 text-balance text-lg text-muted-foreground">{comparison.tagline}</p>
        <div className="mt-6 space-y-4 text-sm leading-relaxed text-muted-foreground">
          {comparison.intro.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <a
            href="https://app.scani.xyz"
            className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-foreground px-6 text-sm font-medium text-background shadow-sm transition-opacity hover:opacity-90"
          >
            Open the app
            <ArrowRight className="h-4 w-4" />
          </a>
          <a
            href={comparison.competitorUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-border bg-card px-6 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Visit {comparison.competitor}
          </a>
        </div>
      </div>
    </section>
  );
}

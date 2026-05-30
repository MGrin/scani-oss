import { ArrowRight, Clock } from 'lucide-react';
import { useRevealOnScroll } from '../../hooks/useRevealOnScroll';

export function BetaPromise() {
  const ref = useRevealOnScroll<HTMLElement>();

  return (
    <section
      ref={ref}
      id="beta"
      data-reveal="section"
      className="border-b border-border/60 bg-gradient-to-b from-background to-card/40 py-12 sm:py-20 lg:py-28"
    >
      <div className="mx-auto max-w-3xl px-6 text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-400">
          <Clock className="h-3 w-3" />
          Beta preview
        </div>
        <h2 className="mt-5 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
          Join now. Lock in 1 year of paid tiers, free.
        </h2>
        <p className="mt-4 text-balance text-muted-foreground">
          Subscriptions aren't live yet. Anyone who creates an account on{' '}
          <a className="underline-offset-4 hover:underline" href="https://app.scani.xyz">
            app.scani.xyz
          </a>{' '}
          or{' '}
          <a className="underline-offset-4 hover:underline" href="https://cloud.scani.xyz">
            cloud.scani.xyz
          </a>{' '}
          gets the equivalent of every paid plan free for the first 12 months once we flip on
          billing.
        </p>

        <div className="mt-10 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
          <a
            href="https://app.scani.xyz"
            className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-foreground px-6 text-sm font-medium text-background shadow-sm transition-opacity hover:opacity-90"
          >
            Open the app
            <ArrowRight className="h-4 w-4" />
          </a>
          <a
            href="https://cloud.scani.xyz"
            className="inline-flex h-11 items-center justify-center gap-2 rounded-md border border-border bg-card px-6 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Get an API key
          </a>
        </div>
      </div>
    </section>
  );
}

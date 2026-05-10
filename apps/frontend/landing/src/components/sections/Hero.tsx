import { ArrowRight, BookOpen } from 'lucide-react';
import { useEffect, useRef } from 'react';

export function Hero() {
  // Hero animation fires on mount (not on scroll) since it's the first
  // thing visible. We set data-revealed="true" in an effect so the
  // initial server-rendered HTML still has the natural opacity:1 +
  // translate:0 baked in via CSS gates — crawlers and no-JS visitors
  // see the page fully composed.
  const heroRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (heroRef.current) heroRef.current.dataset.revealed = 'true';
  }, []);

  return (
    <section
      id="top"
      className="relative isolate overflow-hidden border-b border-border/60 bg-background"
    >
      <div className="bg-grid-fade absolute inset-0 -z-10" aria-hidden="true" />
      <div
        ref={heroRef}
        data-reveal="hero"
        className="mx-auto flex max-w-5xl flex-col items-center px-6 pt-12 pb-16 text-center sm:pt-20 sm:pb-24 lg:pt-28 lg:pb-32"
      >
        <a
          href="#beta"
          className="mb-8 inline-flex items-center gap-2 rounded-full border border-border bg-card/40 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
        >
          <span className="relative flex h-1.5 w-1.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
          </span>
          {/* Short label on mobile (single line); full message on tablet+
           * so the badge doesn't wrap awkwardly on narrow viewports. */}
          <span className="sm:hidden">Beta preview — 1 year free</span>
          <span className="hidden sm:inline">
            Beta preview — lock in 1 year free at every paid tier
          </span>
          <ArrowRight className="h-3 w-3 shrink-0" />
        </a>
        <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-6xl">
          One dashboard for every asset,
          <br className="hidden sm:inline" /> every institution, every chain.
        </h1>
        <p className="mt-6 max-w-2xl text-balance text-base text-muted-foreground sm:text-lg">
          Scani consolidates banks, brokerages, exchanges, and on-chain wallets into a single
          real-time portfolio view — runnable as a managed SaaS, a metered cloud API, or fully
          self-hosted on your own infrastructure.
        </p>
        <div className="mt-10 flex flex-col items-center gap-3 sm:flex-row">
          <a
            href="https://app.scani.xyz"
            className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-foreground px-6 text-sm font-medium text-background shadow-sm transition-opacity hover:opacity-90"
          >
            Open the app
            <ArrowRight className="h-4 w-4" />
          </a>
          {/* Docs aren't ready yet — render as a visibly-disabled button
           * with a "coming soon" pill instead of a working link. Swap
           * back to an <a> once the API docs are publish-ready. */}
          <button
            type="button"
            disabled
            aria-disabled="true"
            className="inline-flex h-11 cursor-not-allowed items-center justify-center gap-2 rounded-md border border-border bg-card px-6 text-sm font-medium text-foreground opacity-60"
          >
            <BookOpen className="h-4 w-4" />
            Read the docs
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              soon
            </span>
          </button>
        </div>
        <p className="mt-6 text-xs text-muted-foreground">
          Free during beta · No credit card · Self-host or use ours
        </p>
      </div>
    </section>
  );
}

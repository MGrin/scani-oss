import { useState } from 'react';
import { useRevealOnScroll } from '../../hooks/useRevealOnScroll';

interface Shot {
  id: string;
  title: string;
  caption: string;
  src: string;
}

const SHOTS: ReadonlyArray<Shot> = [
  {
    id: 'dashboard',
    title: 'Live portfolio',
    caption:
      'Position-level P&L across cash, equities, crypto, and DeFi — recomputed via WebSocket as prices tick.',
    src: '/screenshots/dashboard.png',
  },
  {
    id: 'holdings',
    title: 'Holdings detail',
    caption: 'Cost basis, unrealized P&L, allocation %, and historical price for every position.',
    src: '/screenshots/holdings.png',
  },
  {
    id: 'integrations',
    title: 'Integrations',
    caption:
      'Read-only API keys for exchanges, broker tokens for banks, public addresses for on-chain — managed in one place.',
    src: '/screenshots/integrations.png',
  },
];

// Real screenshots are dropped into `public/screenshots/` by the capture
// script in `scripts/capture-landing-shots.ts`. When the file is missing
// (fresh checkout, before the script has been run), fall back to a
// styled placeholder so the page still composes cleanly.
function Screenshot({ shot }: { shot: Shot }) {
  const [errored, setErrored] = useState(false);
  if (errored) {
    return (
      <div className="flex aspect-[16/10] items-center justify-center rounded-md border border-dashed border-border bg-card text-xs text-muted-foreground">
        Screenshot pending capture
      </div>
    );
  }
  return (
    <img
      src={shot.src}
      alt={shot.title}
      loading="lazy"
      className="aspect-[16/10] w-full rounded-md border border-border bg-card object-cover object-top"
      onError={() => setErrored(true)}
    />
  );
}

export function ProductShowcase() {
  const ref = useRevealOnScroll<HTMLElement>();
  return (
    <section
      ref={ref}
      id="product"
      data-reveal="section"
      className="border-b border-border/60 bg-background py-12 sm:py-20 lg:py-28"
    >
      <div className="mx-auto max-w-6xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            The product
          </p>
          <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            A portfolio operating system, not another dashboard.
          </h2>
        </div>
        <div className="mt-14 grid gap-8 md:grid-cols-3">
          {SHOTS.map((shot) => (
            <figure key={shot.id} className="flex flex-col gap-3">
              <Screenshot shot={shot} />
              <figcaption>
                <div className="text-sm font-medium">{shot.title}</div>
                <p className="mt-1 text-xs text-muted-foreground">{shot.caption}</p>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}

import { useState } from 'react';
import { useRevealOnScroll } from '../../hooks/useRevealOnScroll';
import { type SystemTheme, useSystemPreferences } from '../../hooks/useSystemPreferences';

interface Shot {
  id: string;
  title: string;
  caption: string;
}

const SHOTS: ReadonlyArray<Shot> = [
  {
    id: 'dashboard',
    title: 'Live portfolio',
    caption:
      'Position-level P&L across cash, equities, crypto, and DeFi — recomputed via WebSocket as prices tick.',
  },
  {
    id: 'holdings',
    title: 'Holdings detail',
    caption: 'Cost basis, unrealized P&L, allocation %, and historical price for every position.',
  },
  {
    id: 'integrations',
    title: 'Integrations',
    caption:
      'Read-only API keys for exchanges, broker tokens for banks, public addresses for on-chain — managed in one place.',
  },
];

function variantSrc(id: string, theme: SystemTheme): string {
  // Always the desktop capture, on mobile landing too — the mobile
  // shots don't surface enough of the app. `?v=__BUILD_ID__` busts the
  // browser/CDN cache each deploy, since the capture workflow overwrites
  // these PNGs under stable filenames.
  return `/screenshots/${id}-${theme}-desktop.png?v=${__BUILD_ID__}`;
}

// Real screenshots are dropped into `public/screenshots/` by the GH
// Actions workflow at `.github/workflows/capture-screenshots.yaml`,
// which runs `scripts/capture-landing-shots.ts`. When a variant is
// missing (fresh checkout, before the workflow has run), fall back to
// a styled placeholder so the page still composes cleanly.
function Screenshot({ shot, theme }: { shot: Shot; theme: SystemTheme }) {
  const src = variantSrc(shot.id, theme);
  const [errored, setErrored] = useState<string | null>(null);
  if (errored === src) {
    return (
      <div className="flex aspect-[16/10] items-center justify-center rounded-md border border-dashed border-border bg-card text-xs text-muted-foreground">
        Screenshot pending capture
      </div>
    );
  }
  return (
    <img
      key={src}
      src={src}
      alt={shot.title}
      loading="lazy"
      className="aspect-[16/10] w-full rounded-md border border-border bg-card object-cover object-top"
      onError={() => setErrored(src)}
    />
  );
}

export function ProductShowcase() {
  const ref = useRevealOnScroll<HTMLElement>();
  const { theme } = useSystemPreferences();
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
              <Screenshot shot={shot} theme={theme} />
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

import { useState } from 'react';
import { useRevealOnScroll } from '../../hooks/useRevealOnScroll';
import { type SystemPreferences, useSystemPreferences } from '../../hooks/useSystemPreferences';

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

function variantSrc(id: string, prefs: SystemPreferences): string {
  // `?v=__BUILD_ID__` busts the browser/CDN cache on each deploy — the
  // capture workflow overwrites these PNGs under stable filenames, so a
  // plain path would keep serving the previous capture.
  return `/screenshots/${id}-${prefs.theme}-${prefs.device}.png?v=${__BUILD_ID__}`;
}

// Real screenshots are dropped into `public/screenshots/` by the GH
// Actions workflow at `.github/workflows/capture-screenshots.yaml`,
// which runs `scripts/capture-landing-shots.ts`. When a variant is
// missing (fresh checkout, before the workflow has run), fall back to
// a styled placeholder so the page still composes cleanly.
function Screenshot({ shot, prefs }: { shot: Shot; prefs: SystemPreferences }) {
  const src = variantSrc(shot.id, prefs);
  const [errored, setErrored] = useState<string | null>(null);
  // Desktop shots are captured at 1600×1000 (16:10); mobile shots at the
  // iPhone-14 *viewport* — 390×664, not the 390×844 physical screen.
  // The frame must match the capture aspect or object-cover zooms and
  // crops the screenshot.
  const aspect = prefs.device === 'mobile' ? 'aspect-[390/664]' : 'aspect-[16/10]';
  if (errored === src) {
    return (
      <div
        className={`flex ${aspect} items-center justify-center rounded-md border border-dashed border-border bg-card text-xs text-muted-foreground`}
      >
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
      className={`${aspect} w-full rounded-md border border-border bg-card object-cover object-top`}
      onError={() => setErrored(src)}
    />
  );
}

export function ProductShowcase() {
  const ref = useRevealOnScroll<HTMLElement>();
  const prefs = useSystemPreferences();
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
              <Screenshot shot={shot} prefs={prefs} />
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

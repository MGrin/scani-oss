import { Github } from 'lucide-react';
import { useEffect, useState } from 'react';
import { GITHUB_URL } from '../../seo/siteMeta';
import { ScaniLogo } from '../ScaniLogo';

// Nav anchors visitors hit from the top bar. Curated API-docs links are
// still absent — the docs site isn't published yet; the hero shows a
// "coming soon" pill for the same reason. Re-introduce the docs CTA
// when those land.
//
// Hrefs are root-anchored (`/#…`) so they also resolve from the
// standalone /contact page, not just the home scroll.
const NAV_LINKS: ReadonlyArray<{ label: string; href: string }> = [
  { label: 'Product', href: '/#product' },
  { label: 'Tiers', href: '/#tiers' },
  { label: 'Compare', href: '/alternatives' },
  { label: 'Beta', href: '/#beta' },
];

export function TopNav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header
      className={`sticky top-0 z-50 transition-colors ${
        scrolled
          ? 'border-b border-border/60 bg-background/85 backdrop-blur'
          : 'border-b border-transparent bg-transparent'
      }`}
    >
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
        <a href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <ScaniLogo className="h-6 w-6" />
          Scani
        </a>
        <nav className="hidden items-center gap-6 text-sm md:flex">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              {link.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="View source on GitHub"
            className="inline-flex h-7 items-center justify-center rounded-md border border-border bg-card px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Github className="h-4 w-4" />
          </a>
          <a
            href="https://app.scani.xyz"
            className="rounded-md bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-opacity hover:opacity-90"
          >
            Open the app
          </a>
        </div>
      </div>
    </header>
  );
}

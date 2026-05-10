import { Github } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ScaniLogo } from '../ScaniLogo';

const NAV_LINKS: ReadonlyArray<{ label: string; href: string; external?: boolean }> = [
  { label: 'Product', href: '#product' },
  { label: 'Tiers', href: '#tiers' },
  { label: 'Beta', href: '#beta' },
  { label: 'API docs', href: 'https://api.cloud.scani.xyz/docs', external: true },
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
        <a href="#top" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <ScaniLogo className="h-6 w-6" />
          Scani
        </a>
        <nav className="hidden items-center gap-6 text-sm md:flex">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              target={link.external ? '_blank' : undefined}
              rel={link.external ? 'noreferrer noopener' : undefined}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              {link.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <a
            href="https://github.com/MGrin/scani"
            target="_blank"
            rel="noreferrer noopener"
            className="hidden items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:flex"
            aria-label="GitHub repository"
          >
            <Github className="h-3.5 w-3.5" />
            GitHub
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

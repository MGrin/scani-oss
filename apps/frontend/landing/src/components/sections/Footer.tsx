import { COMPARISONS } from '../../data/comparisons';
import { ScaniLogo } from '../ScaniLogo';

// Curated API-docs links are still absent — the docs site isn't
// published. The OpenAPI spec stays as a developer-reference link;
// it's machine-readable, distinct from a marketed docs site.
const COLUMNS: ReadonlyArray<{ label: string; links: { label: string; href: string }[] }> = [
  {
    label: 'Product',
    links: [
      { label: 'Open the app', href: 'https://app.scani.xyz' },
      { label: 'Cloud console', href: 'https://cloud.scani.xyz' },
    ],
  },
  {
    label: 'Open source',
    links: [
      { label: 'GitHub repo', href: 'https://github.com/MGrin/scani-oss' },
      { label: 'Self-host guide', href: 'https://github.com/MGrin/scani-oss#self-hosting' },
      {
        label: 'Contributing',
        href: 'https://github.com/MGrin/scani-oss/blob/main/CONTRIBUTING.md',
      },
    ],
  },
  {
    label: 'Compare',
    links: [
      { label: 'All alternatives', href: '/alternatives' },
      ...COMPARISONS.map((c) => ({ label: `Scani vs ${c.competitor}`, href: `/vs/${c.slug}` })),
    ],
  },
  {
    label: 'Resources',
    links: [{ label: 'OpenAPI spec', href: 'https://api.cloud.scani.xyz/openapi.json' }],
  },
  {
    label: 'Support',
    links: [
      { label: 'Contact us', href: '/contact' },
      { label: 'support@scani.xyz', href: 'mailto:support@scani.xyz' },
    ],
  },
];

export function Footer() {
  return (
    <footer className="bg-background py-12">
      <div className="mx-auto grid max-w-6xl gap-10 px-6 md:grid-cols-[1fr_auto] md:items-start">
        <div>
          <a href="/" className="inline-flex items-center gap-2 text-sm font-semibold">
            <ScaniLogo className="h-5 w-5" />
            Scani
          </a>
          <p className="mt-3 max-w-sm text-xs text-muted-foreground">
            Personal wealth, consolidated. Self-host or use ours.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-10 sm:grid-cols-5">
          {COLUMNS.map((col) => (
            <div key={col.label}>
              <div className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                {col.label}
              </div>
              <ul className="mt-3 space-y-2 text-sm">
                {col.links.map((link) => (
                  <li key={link.href}>
                    <a
                      href={link.href}
                      target={link.href.startsWith('http') ? '_blank' : undefined}
                      rel={link.href.startsWith('http') ? 'noreferrer noopener' : undefined}
                      className="text-foreground/80 transition-colors hover:text-foreground"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
      <div className="mx-auto mt-12 flex max-w-6xl flex-col items-start gap-3 border-t border-border px-6 pt-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
        <span>© {new Date().getFullYear()} Scani. All rights reserved.</span>
      </div>
    </footer>
  );
}

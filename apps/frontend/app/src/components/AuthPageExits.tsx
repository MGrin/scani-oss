import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * The ways out of the sign-in screen (SC-1209).
 *
 * `/auth` rendered **zero anchors** — measured on `app.scani.xyz` and again on
 * a local stack: `anchors 0 · hrefs []`. It is SC-997's defect on the surface
 * SC-997 did not cover, and `apps/frontend/cloud/src/components/AuthPageExits.tsx`
 * is the fix this mirrors rather than a pattern invented here.
 *
 * The trap is the same one SC-121 closed on the reference page: a visitor sent
 * here from a link has the URL bar and nothing else, and **an installed PWA
 * does not have one** (SC-62, SC-73). Unlike cloud, this is the front door of
 * the product itself, so the exits are the three things a visitor who is not
 * ready to hand over an email would want — what this is, how it works, and a
 * version they can look at without an account.
 *
 * **Bare hostnames rather than labels**, which is what cloud already ships for
 * `scani.xyz`: they are addresses, not copy, so there is nothing here for nine
 * locales to disagree about and nothing to keep in sync with the sites they
 * point at. The demo is the one worth the click — SC-450 measured 15 signups
 * against 2 returns, so "look before you commit" is the path the demo exists
 * to serve — and `demo.scani.xyz` says what it is without being translated.
 *
 * Hardcoded rather than read from the environment, as cloud's `LANDING_HREF`
 * is: these are this project's own sites, and a self-hoster's sign-in screen
 * pointing at them is accurate rather than a leak.
 */

/** The marketing site, which is where a visitor most often arrives from. */
const LANDING_HREF = 'https://scani.xyz';
const DOCS_HREF = 'https://docs.scani.xyz';
/** A whole portfolio, seeded and read-only, with no account and no email. */
const DEMO_HREF = 'https://demo.scani.xyz';

const EXIT =
  'flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function AuthPageExits() {
  const { t } = useTranslation();
  return (
    <nav aria-label={t('auth.exits.label')} className="flex flex-wrap justify-center gap-2">
      <a href={LANDING_HREF} className={EXIT}>
        <ArrowLeft className="h-3.5 w-3.5 shrink-0 rtl:rotate-180" aria-hidden="true" />
        <span>scani.xyz</span>
      </a>
      <a href={DOCS_HREF} className={EXIT}>
        docs.scani.xyz
      </a>
      <a href={DEMO_HREF} className={EXIT}>
        demo.scani.xyz
      </a>
    </nav>
  );
}

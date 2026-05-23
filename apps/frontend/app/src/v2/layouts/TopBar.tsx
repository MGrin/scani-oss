import { Button } from '@scani/ui/ui/button';
import { Menu, Plus, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';
import { JobsBadge } from '../components/JobsBadge';
import { V2_ROUTES } from '../lib/routes';

interface TopBarProps {
  onMobileMenuOpen: () => void;
  onCommandPaletteOpen: () => void;
  /** When > 0, renders an amber dot over the mobile hamburger so users who
   * only see the bottom-nav + top bar still notice pending review jobs. */
  actionRequiredCount?: number;
}

/** Map the first path segment to an i18n nav key when we have a
 * translation for it. Routes we haven't extracted yet fall back to the
 * old behaviour (slug → Title Case). */
const TITLE_KEY_BY_SEGMENT: Record<string, string> = {
  holdings: 'nav.holdings',
  accounts: 'nav.accounts',
  institutions: 'nav.institutions',
  groups: 'nav.groups',
  vaults: 'nav.vaults',
  tokens: 'nav.tokens',
  integrations: 'nav.integration',
  import: 'nav.uploadFile',
  'wallet-import': 'nav.cryptoWallet',
  'manual-entry': 'nav.manualEntry',
  'add-data': 'nav.addDataButton',
  settings: 'nav.settings',
  jobs: 'nav.jobs',
};

function getPageTitle(pathname: string, t: (k: string) => string): string {
  const segment = pathname.split('/').filter(Boolean)[0];
  if (!segment) return t('nav.dashboard');
  const key = TITLE_KEY_BY_SEGMENT[segment];
  if (key) return t(key);
  return segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, ' ');
}

/** Context-aware "Add" link. Returns null only on the Add Data page
 * itself (no point linking back to where you are). Everywhere else
 * gets the button — some routes pre-fill context (account/institution
 * detail), the rest get the plain "Add Data" entry. */
function getAddLink(
  pathname: string,
  t: (k: string) => string
): { href: string; label: string } | null {
  // Hide on the Add Data page itself + its sub-flows to avoid a link
  // that navigates to where the user already is.
  if (pathname.startsWith(V2_ROUTES.addData)) return null;

  const accountMatch = pathname.match(/^\/accounts\/([^/]+)$/);
  if (accountMatch) {
    return { href: `${V2_ROUTES.addData}?accountId=${accountMatch[1]}`, label: t('nav.add') };
  }
  const instMatch = pathname.match(/^\/institutions\/([^/]+)$/);
  if (instMatch) {
    return { href: `${V2_ROUTES.addData}?institutionId=${instMatch[1]}`, label: t('nav.add') };
  }
  return { href: V2_ROUTES.addData, label: t('nav.addDataButton') };
}

export function TopBar({
  onMobileMenuOpen,
  onCommandPaletteOpen,
  actionRequiredCount = 0,
}: TopBarProps) {
  const { pathname } = useLocation();
  const { t } = useTranslation();
  const title = getPageTitle(pathname, t);
  const addLink = getAddLink(pathname, t);
  const hasActionRequired = actionRequiredCount > 0;

  return (
    <header
      className="flex items-center gap-3 px-4 border-b border-border bg-background/80 backdrop-blur-sm shrink-0"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        minHeight: 'calc(3rem + env(safe-area-inset-top))',
      }}
    >
      {/* Mobile hamburger */}
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden h-8 w-8 relative"
        onClick={onMobileMenuOpen}
        aria-label={
          hasActionRequired
            ? `${t('nav.openMenu')} — ${actionRequiredCount} job${actionRequiredCount === 1 ? '' : 's'} need review`
            : t('nav.openMenu')
        }
      >
        <Menu className="h-4 w-4" />
        {hasActionRequired && (
          <span
            aria-hidden="true"
            className="absolute top-1 right-1 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-background"
          />
        )}
      </Button>

      {/* Page title */}
      <h1 className="text-sm font-medium text-foreground">{title}</h1>

      <div className="flex-1" />

      {/* Background-jobs activity indicator. Hidden below the sidebar
          breakpoint — mobile users reach Jobs via the sidebar (rendered
          in the "More" drawer) + MobileNav, so duplicating the badge in
          the top row just eats width. */}
      <JobsBadge className="hidden lg:inline-flex" />

      {/* Context-aware Add button */}
      {addLink && (
        <Button variant="outline" size="sm" className="h-7 text-xs" asChild>
          <Link to={addLink.href}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            {addLink.label}
          </Link>
        </Button>
      )}

      {/* Command palette trigger */}
      <button
        type="button"
        onClick={onCommandPaletteOpen}
        className="hidden sm:flex items-center gap-2 h-7 px-2.5 rounded-md border border-border bg-muted/50 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
      >
        <Search className="h-3 w-3" />
        <span>{t('nav.search')}</span>
        <kbd className="pointer-events-none inline-flex h-4 select-none items-center gap-0.5 rounded border border-border bg-muted px-1 font-mono text-[9px] font-medium text-muted-foreground">
          <span>⌘</span>K
        </kbd>
      </button>

      {/* Mobile search button */}
      <Button
        variant="ghost"
        size="icon"
        className="sm:hidden h-8 w-8"
        onClick={onCommandPaletteOpen}
        aria-label={t('nav.search')}
      >
        <Search className="h-4 w-4" />
      </Button>
    </header>
  );
}

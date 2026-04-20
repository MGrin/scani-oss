import { Menu, Plus, Search } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { JobsBadge } from '../components/JobsBadge';
import { V2_ROUTES } from '../lib/routes';

interface TopBarProps {
  onMobileMenuOpen: () => void;
  onCommandPaletteOpen: () => void;
  /** When > 0, renders an amber dot over the mobile hamburger so users who
   * only see the bottom-nav + top bar still notice pending review jobs. */
  actionRequiredCount?: number;
}

/** Derive page title from URL path */
function getPageTitle(pathname: string): string {
  const segment = pathname.split('/').filter(Boolean)[0];
  if (!segment) return 'Dashboard';
  return segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, ' ');
}

/** Context-aware "Add" link. Returns null only on the Add Data page
 * itself (no point linking back to where you are). Everywhere else
 * gets the button — some routes pre-fill context (account/institution
 * detail), the rest get the plain "Add Data" entry. */
function getAddLink(pathname: string): { href: string; label: string } | null {
  // Hide on the Add Data page itself + its sub-flows to avoid a link
  // that navigates to where the user already is.
  if (pathname.startsWith(V2_ROUTES.addData)) return null;

  const accountMatch = pathname.match(/^\/accounts\/([^/]+)$/);
  if (accountMatch) {
    return { href: `${V2_ROUTES.addData}?accountId=${accountMatch[1]}`, label: 'Add' };
  }
  const instMatch = pathname.match(/^\/institutions\/([^/]+)$/);
  if (instMatch) {
    return { href: `${V2_ROUTES.addData}?institutionId=${instMatch[1]}`, label: 'Add' };
  }
  return { href: V2_ROUTES.addData, label: 'Add Data' };
}

export function TopBar({
  onMobileMenuOpen,
  onCommandPaletteOpen,
  actionRequiredCount = 0,
}: TopBarProps) {
  const { pathname } = useLocation();
  const title = getPageTitle(pathname);
  const addLink = getAddLink(pathname);
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
            ? `Open menu — ${actionRequiredCount} job${actionRequiredCount === 1 ? '' : 's'} need review`
            : 'Open menu'
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
        <span>Search</span>
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
        aria-label="Search"
      >
        <Search className="h-4 w-4" />
      </Button>
    </header>
  );
}

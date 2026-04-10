import { Menu, Plus, Search } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { V2_ROUTES } from '../lib/routes';

interface TopBarProps {
  onMobileMenuOpen: () => void;
  onCommandPaletteOpen: () => void;
}

/** Derive page title from URL path */
function getPageTitle(pathname: string): string {
  const segment = pathname.replace('/v2', '').split('/').filter(Boolean)[0];
  if (!segment) return 'Dashboard';
  return segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, ' ');
}

/** Get context-aware add link based on current page */
function getAddLink(pathname: string): { href: string; label: string } | null {
  const clean = pathname.replace('/v2', '');

  // Account detail page → add data with account preselected
  const accountMatch = clean.match(/^\/accounts\/([^/]+)$/);
  if (accountMatch) {
    return { href: `${V2_ROUTES.addData}?accountId=${accountMatch[1]}`, label: 'Add' };
  }
  // Institution detail → add data with institution preselected
  const instMatch = clean.match(/^\/institutions\/([^/]+)$/);
  if (instMatch) {
    return { href: `${V2_ROUTES.addData}?institutionId=${instMatch[1]}`, label: 'Add' };
  }
  // Holdings list, Accounts list, Dashboard
  if (clean === '/holdings' || clean === '/' || clean === '/accounts') {
    return { href: V2_ROUTES.addData, label: 'Add Data' };
  }

  return null;
}

export function TopBar({ onMobileMenuOpen, onCommandPaletteOpen }: TopBarProps) {
  const { pathname } = useLocation();
  const title = getPageTitle(pathname);
  const addLink = getAddLink(pathname);

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
        className="lg:hidden h-8 w-8"
        onClick={onMobileMenuOpen}
        aria-label="Open menu"
      >
        <Menu className="h-4 w-4" />
      </Button>

      {/* Page title */}
      <h1 className="text-sm font-medium text-foreground">{title}</h1>

      <div className="flex-1" />

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

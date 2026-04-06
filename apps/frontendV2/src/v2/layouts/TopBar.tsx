import { Menu, Search } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';

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

export function TopBar({ onMobileMenuOpen, onCommandPaletteOpen }: TopBarProps) {
  const { pathname } = useLocation();
  const title = getPageTitle(pathname);

  return (
    <header
      className="flex items-center gap-3 px-4 border-b border-border bg-background/80 backdrop-blur-sm shrink-0"
      style={{ paddingTop: 'env(safe-area-inset-top)', minHeight: 'calc(3rem + env(safe-area-inset-top))' }}
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

      {/* Command palette trigger */}
      <button
        type="button"
        onClick={onCommandPaletteOpen}
        className="hidden sm:flex items-center gap-2 h-8 px-3 rounded-md border border-border bg-muted/50 text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
      >
        <Search className="h-3.5 w-3.5" />
        <span>Search...</span>
        <kbd className="ml-2 pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border border-border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
          <span className="text-xs">⌘</span>K
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

import { ThemeToggle } from '@scani/ui/components/ThemeToggle';
import { Button } from '@scani/ui/ui/button';
import { Plus, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { navIcon } from '../lib/nav-icons';
import { V3_ROUTES, V3_SIDEBAR_SECTIONS } from '../lib/routes';

interface V3SidebarProps {
  /** Result of `resolveActiveV3Path` — longest match, so a detail page
   * lights the list it lives under. */
  activePath: string | null;
  actionRequiredCount?: number;
  /** Opens the capture sheet. The desktop counterpart of the tab bar's centre
   *  slot — capture has no sidebar section because it is not a destination. */
  onCapturePress: () => void;
}

/**
 * Desktop navigation. The phone gets five ranked slots because that is all
 * a tab bar can hold honestly; a sidebar has room to show the structure
 * instead, so it groups rather than ranks.
 *
 * No collapse toggle. v2's exists because 13 entries plus a 256px column
 * crowd a laptop; the width here is the same and the answer to "it is in
 * the way" is a smaller sidebar, not a second state to maintain.
 *
 * No `min-h-tap` on the rows — see the note in `DataRow.tsx`. This surface is
 * `lg`-and-up, so the pointer in front of it is usually a mouse; the token
 * layer still hands every row 44px under `pointer: coarse`, which is the
 * tablet case this sidebar also serves.
 */
export function V3Sidebar({ activePath, actionRequiredCount = 0, onCapturePress }: V3SidebarProps) {
  const { t } = useTranslation();

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-e border-border bg-surface-1 lg:flex">
      {/* No "v3" chip beside the wordmark since V3-19: this is the interface
          the app serves, and a version badge on the default reads as a beta the
          reader has been opted into. The way out is the switch in the footer. */}
      <div className="flex h-14 shrink-0 items-center px-4">
        <span className="text-title">Scani</span>
      </div>

      {/* Above the sections rather than inside one: the phone gives capture a
          slot of its own precisely because it belongs to no section, and a
          sidebar that filed it under Portfolio would be claiming otherwise. */}
      <div className="shrink-0 px-2 pb-2">
        <Button className="w-full justify-start" onClick={onCapturePress}>
          <Plus className="me-2 h-4 w-4" aria-hidden="true" />
          {/* `nav.addData`, not v2's `nav.addDataButton`: sentence case is a
              v3 writing rule (§7) and retitling the shared key would rewrite
              v2's own top bar. */}
          {t('nav.addData')}
        </Button>
      </div>

      <nav
        aria-label={t('v3.shell.sidebar.landmark')}
        className="min-h-0 flex-1 space-y-5 overflow-y-auto px-2 py-2"
      >
        {V3_SIDEBAR_SECTIONS.map((section) => (
          <div key={section.titleKey}>
            <p className="mb-1 px-3 text-caption uppercase tracking-wider text-muted-foreground">
              {t(section.titleKey)}
            </p>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const Icon = navIcon(item.icon);
                const isActive = item.path === activePath;
                const badge = item.path === V3_ROUTES.review ? actionRequiredCount : 0;
                return (
                  <li key={item.path}>
                    <Link
                      to={item.path}
                      aria-current={isActive ? 'page' : undefined}
                      className={cn(
                        'flex items-center gap-3 rounded-md px-3 py-2 text-label transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        isActive
                          ? 'bg-surface-hover text-interactive'
                          : 'text-muted-foreground hover:bg-surface-hover hover:text-foreground'
                      )}
                      style={{ transitionDuration: 'var(--motion-fast)' }}
                    >
                      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className="truncate">{t(item.labelKey)}</span>
                      {badge > 0 && (
                        <span className="ms-auto inline-flex items-center justify-center rounded-full bg-interactive px-1.5 py-0.5 text-caption font-medium leading-none text-interactive-foreground">
                          {badge}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="shrink-0 space-y-0.5 border-t border-border p-2">
        <Link
          to={V3_ROUTES.settings}
          aria-current={V3_ROUTES.settings === activePath ? 'page' : undefined}
          className={cn(
            'flex items-center gap-3 rounded-md px-3 py-2 text-label',
            V3_ROUTES.settings === activePath
              ? 'bg-surface-hover text-interactive'
              : 'text-muted-foreground hover:bg-surface-hover hover:text-foreground'
          )}
        >
          <Settings className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t('nav.settings')}</span>
        </Link>
        <ThemeToggle variant="row" side="top" align="start" className="px-3 py-2 text-label" />
      </div>
    </aside>
  );
}

import { History, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import {
  counterpartPath,
  storeUiVersion,
  type UiVersion,
  uiVersionForPath,
} from '../lib/ui-version';

export interface UiVersionSwitchProps {
  /** Render the trigger as a full-width row (label + icon) instead of an icon-only square. */
  variant?: 'icon' | 'row';
  /** Override the trigger's class names. */
  className?: string;
}

/**
 * Crosses between the two interfaces, in both directions, from wherever the
 * user currently is. Present in v2's chrome as well as v3's so there is always
 * a way back — on a phone, mid-session, without knowing the URL scheme. It is
 * permanent chrome, not a migration affordance: the classic UI stays.
 *
 * **Both labels read from the default outward** (V3-19). v3 is what the app
 * serves now, so "Try the new UI" — which framed v3 as the experiment — became
 * false the moment it stopped being one. The pair is "Back to the classic UI"
 * and "Back to the new UI": whichever one you are reading, you got here by
 * leaving the other.
 *
 * The query string comes along (V3-46). Both generations spell their filter
 * keys identically on purpose, so a narrowed holdings list stays narrowed
 * across the switch instead of silently resetting.
 *
 * The classic-UI icon is `History`, not `Undo2` (SC-71 7.3). As an undo arrow
 * — 44×44, unlabelled to the eye, sitting in the header next to the theme
 * control — the one button that replaces the entire interface read as "undo my
 * last change", which is a destructive-sounding promise about the user's data
 * rather than a true one about the app's chrome. A clock-with-an-arrow says
 * "the previous version", which is what it does.
 */
export function UiVersionSwitch({ variant = 'row', className }: UiVersionSwitchProps) {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const target: UiVersion = uiVersionForPath(pathname) === 'v3' ? 'v2' : 'v3';
  const label = target === 'v3' ? t('nav.backToNewUi') : t('nav.backToClassicUi');
  const Icon = target === 'v3' ? Sparkles : History;

  const handleClick = () => {
    storeUiVersion(target);
    navigate(counterpartPath(pathname, target, search));
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex items-center gap-2.5 rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        variant === 'row' ? 'w-full px-2 py-1.5 text-[13px]' : 'h-9 w-9 justify-center p-1.5',
        className
      )}
    >
      <Icon
        className={cn(variant === 'row' ? 'h-4 w-4 shrink-0' : 'h-5 w-5 shrink-0')}
        aria-hidden="true"
      />
      {variant === 'row' && <span className="truncate">{label}</span>}
    </button>
  );
}

import { Button } from '@scani/ui/ui/button';
import { Eye, EyeOff } from 'lucide-react';
import { createContext, type ReactNode, useContext, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  readViewPreference,
  VIEW_PREFERENCE_KEYS,
  writeViewPreference,
} from '../../lib/view-preference';

/**
 * Whether the hero's money figures are readable when Home opens (SC-1375).
 *
 * A per-DEVICE default, which is why it lives in `localStorage` beside the
 * other home view preferences rather than on the account: the same reader wants
 * the figure hidden on a phone opened in public and shown on a laptop at home.
 */
const FIGURE_VISIBILITIES = ['shown', 'hidden'] as const;
export type FigureVisibility = (typeof FIGURE_VISIBILITIES)[number];

export function readFigureVisibility(storage?: Parameters<typeof readViewPreference>[3]) {
  return readViewPreference<FigureVisibility>(
    VIEW_PREFERENCE_KEYS.homeFigureVisibility,
    'shown',
    FIGURE_VISIBILITIES,
    storage
  );
}

/**
 * `settingHidden` is the saved per-device choice the eye changes. A tap on the
 * blurred figure only PEEKS (SC-1376): it reveals this view and saves nothing,
 * so the next time Home opens it is hidden again.
 */
function useFigureVisibility() {
  const [visibility, setVisibility] = useState<FigureVisibility>(() => readFigureVisibility());
  const [peeking, setPeeking] = useState(false);
  const settingHidden = visibility === 'hidden';
  const toggle = () => {
    const next: FigureVisibility = settingHidden ? 'shown' : 'hidden';
    writeViewPreference(VIEW_PREFERENCE_KEYS.homeFigureVisibility, next);
    setVisibility(next);
    setPeeking(false);
  };
  const togglePeek = () => setPeeking((current) => !current);
  return {
    settingHidden,
    hidden: settingHidden && !peeking,
    onPeek: settingHidden ? togglePeek : undefined,
    toggle,
  };
}

type FigureVisibilityState = ReturnType<typeof useFigureVisibility>;

/**
 * One eye for the whole of Home (SC-1669). The compact hero, its peek and the
 * tiles each kept their own copy before, so hiding amounts in the peek left
 * the hero and every tile figure on screen.
 */
export const FigureVisibilityContext = createContext<FigureVisibilityState | null>(null);

export function FigureVisibilityProvider({ children }: { children: ReactNode }) {
  const visibility = useFigureVisibility();
  return (
    <FigureVisibilityContext.Provider value={visibility}>
      {children}
    </FigureVisibilityContext.Provider>
  );
}

/** The page's shared state under a provider, and this component's own otherwise. */
export function useSharedFigureVisibility(): FigureVisibilityState {
  const own = useFigureVisibility();
  return useContext(FigureVisibilityContext) ?? own;
}

/**
 * Blurred rather than replaced with dots: the figure keeps its width, so
 * toggling never moves the rest of the block. It is hidden from assistive
 * technology while blurred and a spoken "amount hidden" stands in for it.
 */
export function MaskedFigure({
  hidden,
  onPeek,
  children,
}: {
  hidden: boolean;
  /** Present only while the saved setting is hidden: the figure is then a
   *  control that reveals it, and hides it again, without saving anything. */
  onPeek?: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const content = hidden ? (
    <>
      <span aria-hidden="true" data-figure-masked="" className="select-none blur-md">
        {children}
      </span>
      <span className="sr-only">{t('v3.home.hero.figureHidden')}</span>
    </>
  ) : (
    children
  );
  if (!onPeek) return <>{content}</>;
  return (
    <button
      type="button"
      data-figure-peek=""
      aria-label={hidden ? t('v3.home.hero.showFigure') : undefined}
      onClick={onPeek}
      className="cursor-pointer text-start"
    >
      {content}
    </button>
  );
}

export function FigureVisibilityToggle({
  hidden,
  onToggle,
}: {
  hidden: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const Icon = hidden ? EyeOff : Eye;
  return (
    <Button
      variant="ghost"
      size="icon"
      className="-my-3 text-muted-foreground"
      aria-pressed={hidden}
      aria-label={t(hidden ? 'v3.home.hero.showFigure' : 'v3.home.hero.hideFigure')}
      onClick={onToggle}
    >
      <Icon aria-hidden="true" className="h-4 w-4" />
    </Button>
  );
}

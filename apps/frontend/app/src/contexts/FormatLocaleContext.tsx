import type { FormatLocale } from '@scani/shared';
import {
  createContext,
  Fragment,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  applyFormatLocale,
  browserStorage,
  readStoredRegion,
  writeStoredRegion,
} from '@/i18n/format-locale';

/**
 * Keeps the formatters, `<html lang>` and `<html dir>` on the reader's locale
 * (SC-201).
 *
 * ## Why the formatters are not a context value
 *
 * Because 44 call sites in v3, 3 more in `@scani/ui`, and every one in the api
 * and worker call `formatDate(x)` / `formatCurrency(x, 'USD')` with no locale
 * argument — which is what the two pins' doc comments told them to do, in
 * writing, since SC-175. Threading a locale through all of them is the change
 * those comments exist to avoid. So the resolved locale is published to a
 * module-level seam in `@scani/shared` and the call sites stay untouched.
 *
 * ## Which means this provider owes a re-render
 *
 * A component that formats a date but never calls `t()` subscribes to nothing,
 * so nothing re-renders it when the seam changes. `key` on a fragment is the
 * blunt answer and the right one here: changing the region is a deliberate,
 * rare act, and a remount is the only thing that provably re-renders every
 * formatted string on screen rather than the ones we remembered to check. It
 * is mounted above `AuthProvider` but below `TRPCProvider`, so the query cache
 * survives the remount and no screen refetches.
 *
 * The apply happens in `useMemo` rather than an effect on purpose: an effect
 * runs *after* children render, so the first paint after a change would use
 * the previous locale. Writing to an external store before children read it is
 * what this is, it is idempotent, and StrictMode's double render is harmless.
 */

interface FormatLocaleValue {
  locale: FormatLocale;
  /** The region in effect — `AUTO_REGION` when none is chosen. */
  region: string;
  setRegion: (region: string) => void;
}

const FormatLocaleContext = createContext<FormatLocaleValue | null>(null);

export function FormatLocaleProvider({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation();
  const [region, setRegionState] = useState(() => readStoredRegion(browserStorage()));
  const language = i18n.resolvedLanguage ?? i18n.language;

  const locale = useMemo(() => applyFormatLocale(language, region, document), [language, region]);

  const setRegion = useCallback((next: string) => {
    writeStoredRegion(browserStorage(), next);
    setRegionState(next);
  }, []);

  // `locale.region`, not the raw state: a stale or hand-edited storage value
  // normalises to `auto` on the way through `resolveFormatLocale`, and the
  // control has to show what is happening rather than what is stored. A
  // `<select>` reading "Atlantis" over English dates is the worse of the two.
  const value = useMemo(() => ({ locale, region: locale.region, setRegion }), [locale, setRegion]);

  return (
    <FormatLocaleContext.Provider value={value}>
      {/* A keyed Fragment rather than a wrapper element: it remounts the tree
          without adding a node to the DOM, so no layout, selector or a11y tree
          changes to buy the re-render. */}
      <Fragment key={`${locale.dateLocale}:${locale.numberLocale}`}>{children}</Fragment>
    </FormatLocaleContext.Provider>
  );
}

export function useFormatLocale(): FormatLocaleValue {
  const value = useContext(FormatLocaleContext);
  if (!value) throw new Error('useFormatLocale must be used within a FormatLocaleProvider');
  return value;
}

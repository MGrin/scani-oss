import { useCallback, useState } from 'react';
import {
  readViewPreference,
  type ViewPreferenceKey,
  writeViewPreference,
} from '../lib/view-preference';

/**
 * `useState` for a control that selects a *view*, with the choice remembered
 * across reloads — the convention for every v3 toggle that is not already a
 * route and not already inside `useDataView`.
 *
 * `allowed` is what makes it safe to persist: every value is checked against the
 * options that exist *now*, so one written by an older build resolves to
 * `fallback` instead of asking the API for a cut it no longer serves. The
 * setter takes a bare `string` for the same reason — `Segmented` hands back
 * whatever is on the pressed item, and a call site that has to cast is a call
 * site where the check can be cast away.
 *
 * Storage is read once, lazily, on the first render. The app is a
 * client-rendered SPA, so there is no hydration pass for a differing initial
 * value to disagree with.
 */
export function useViewPreference<T extends string>(
  key: ViewPreferenceKey,
  fallback: T,
  allowed: readonly T[]
): [T, (next: string) => void] {
  const [value, setValue] = useState<T>(() => readViewPreference(key, fallback, allowed));

  const choose = useCallback(
    (next: string) => {
      const resolved = allowed.find((option) => option === next) ?? fallback;
      setValue(resolved);
      writeViewPreference(key, resolved);
    },
    [key, fallback, allowed]
  );

  return [value, choose];
}

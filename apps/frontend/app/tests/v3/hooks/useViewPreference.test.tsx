import { afterEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { useViewPreference } from '../../../src/v3/hooks/useViewPreference';
import {
  VIEW_PREFERENCE_KEYS,
  viewPreferenceStorageKey,
} from '../../../src/v3/lib/view-preference';

/**
 * The hook's read path, exercised the only way it can be here: server-render a
 * probe and read what it chose. There is no DOM under `bun test`, so the
 * no-window case is the ambient one — which is also the case that matters,
 * since every v3 component test goes through `renderToStaticMarkup`.
 *
 * For the stored cases the global is stubbed rather than mocked, because
 * `browserStorage()` reaches for `window.localStorage` and the point of the
 * test is that reach.
 */

const globals = globalThis as { window?: unknown };

function stubWindow(stored: Record<string, string>) {
  const data = new Map(Object.entries(stored));
  globals.window = {
    localStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
    },
  };
  return data;
}

afterEach(() => {
  globals.window = undefined;
});

const CUTS = ['token_type', 'institution', 'account', 'group'] as const;

function Probe() {
  const [dimension] = useViewPreference(
    VIEW_PREFERENCE_KEYS.homeAllocationDimension,
    'token_type',
    CUTS
  );
  return <span data-cut={dimension} />;
}

describe('useViewPreference', () => {
  test('renders without storage at all — no throw, and the default is chosen', () => {
    expect(renderToStaticMarkup(<Probe />)).toInclude('data-cut="token_type"');
  });

  test('a stored choice is what the first render shows', () => {
    stubWindow({
      [viewPreferenceStorageKey(VIEW_PREFERENCE_KEYS.homeAllocationDimension)]: 'account',
    });
    expect(renderToStaticMarkup(<Probe />)).toInclude('data-cut="account"');
  });

  test('a stored choice that is no longer an option renders the default', () => {
    stubWindow({
      [viewPreferenceStorageKey(VIEW_PREFERENCE_KEYS.homeAllocationDimension)]: 'account_type',
    });
    expect(renderToStaticMarkup(<Probe />)).toInclude('data-cut="token_type"');
  });
});

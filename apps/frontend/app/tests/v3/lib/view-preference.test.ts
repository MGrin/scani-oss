import { describe, expect, test } from 'bun:test';
import {
  readViewPreference,
  VIEW_PREFERENCE_KEYS,
  viewPreferenceStorageKey,
  writeViewPreference,
} from '../../../src/v3/lib/view-preference';

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    raw: data,
  };
}

/** Storage that throws the way Safari does with site data blocked. */
function hostileStorage() {
  return {
    getItem(): string {
      throw new Error('access denied');
    },
    setItem(): void {
      throw new Error('quota exceeded');
    },
  };
}

const CUTS = ['token_type', 'institution', 'account', 'group'] as const;

describe('viewPreferenceStorageKey', () => {
  test('every key is v3-namespaced, so none can collide with a v2 record', () => {
    for (const key of Object.values(VIEW_PREFERENCE_KEYS)) {
      expect(viewPreferenceStorageKey(key)).toStartWith('scani.v3.view.');
      expect(viewPreferenceStorageKey(key)).not.toInclude('scani-v2');
    }
  });

  test('the keys are distinct, so two controls cannot overwrite each other', () => {
    const keys = Object.values(VIEW_PREFERENCE_KEYS).map(viewPreferenceStorageKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('readViewPreference', () => {
  test('a stored option is returned', () => {
    const storage = fakeStorage({
      [viewPreferenceStorageKey(VIEW_PREFERENCE_KEYS.homeAllocationDimension)]: 'group',
    });
    expect(
      readViewPreference(VIEW_PREFERENCE_KEYS.homeAllocationDimension, 'token_type', CUTS, storage)
    ).toBe('group');
  });

  test('nothing stored is the default', () => {
    expect(
      readViewPreference(
        VIEW_PREFERENCE_KEYS.homeAllocationDimension,
        'token_type',
        CUTS,
        fakeStorage()
      )
    ).toBe('token_type');
  });

  // The rule the ticket is really about: a preference selects a view, and if
  // the view is gone the default takes over silently rather than the block
  // asking the API for a cut it no longer serves.
  test('a value naming an option that no longer exists falls back', () => {
    const storage = fakeStorage({
      [viewPreferenceStorageKey(VIEW_PREFERENCE_KEYS.homeAllocationDimension)]: 'institution_type',
    });
    expect(
      readViewPreference(VIEW_PREFERENCE_KEYS.homeAllocationDimension, 'token_type', CUTS, storage)
    ).toBe('token_type');
  });

  test('junk in the slot falls back rather than throwing', () => {
    const storage = fakeStorage({
      [viewPreferenceStorageKey(VIEW_PREFERENCE_KEYS.homeMetric)]: '{"not":"a metric"}',
    });
    expect(readViewPreference(VIEW_PREFERENCE_KEYS.homeMetric, 'net-worth', ['pnl'], storage)).toBe(
      'net-worth'
    );
  });

  test('storage that throws on read is the default, not an error', () => {
    expect(
      readViewPreference(VIEW_PREFERENCE_KEYS.homePeriod, '30d', ['7d', '30d'], hostileStorage())
    ).toBe('30d');
  });

  test('no window at all — server rendering — is the default', () => {
    expect(readViewPreference(VIEW_PREFERENCE_KEYS.homePeriod, '30d', ['7d', '30d'])).toBe('30d');
  });
});

describe('writeViewPreference', () => {
  test('the choice lands under its own namespaced key', () => {
    const storage = fakeStorage();
    writeViewPreference(VIEW_PREFERENCE_KEYS.homePeriod, '365d', storage);
    expect(storage.raw.get('scani.v3.view.home.period')).toBe('365d');
  });

  test('a write round-trips through a read', () => {
    const storage = fakeStorage();
    writeViewPreference(VIEW_PREFERENCE_KEYS.homeMetric, 'pnl', storage);
    expect(
      readViewPreference(
        VIEW_PREFERENCE_KEYS.homeMetric,
        'net-worth',
        ['net-worth', 'pnl'],
        storage
      )
    ).toBe('pnl');
  });

  test('storage that throws on write is swallowed — the control still works', () => {
    expect(() =>
      writeViewPreference(VIEW_PREFERENCE_KEYS.homeMetric, 'pnl', hostileStorage())
    ).not.toThrow();
  });

  test('no window at all does not throw', () => {
    expect(() => writeViewPreference(VIEW_PREFERENCE_KEYS.homeMetric, 'pnl')).not.toThrow();
  });
});

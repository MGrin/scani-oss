import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import i18n from 'i18next';
import {
  DEFAULT_TOKEN_SEGMENT,
  hiddenReasonLabel,
  isScamFlagged,
  isScamToken,
  resolveTokenSegment,
  TOKEN_SEGMENTS,
  TOKEN_TYPE_LABELS,
  TOKENS_HIDDEN_PATH,
  tokenSegmentPath,
  tokenTypeLabel,
} from '../../../src/v3/lib/tokens';

const t = i18n.t.bind(i18n);

describe('resolveTokenSegment', () => {
  test('the index is the custom list', () => {
    expect(resolveTokenSegment('/v3/tokens')).toBe('custom');
    expect(resolveTokenSegment('/v3/tokens/')).toBe('custom');
  });

  test('claims `hidden` before the peek id space', () => {
    // The collision this exists to prevent: `/v3/tokens/hidden` read as a peek
    // would open a custom-token sheet for a token id of "hidden".
    expect(resolveTokenSegment(TOKENS_HIDDEN_PATH)).toBe('hidden');
    expect(resolveTokenSegment(`${TOKENS_HIDDEN_PATH}/holding-uuid`)).toBe('hidden');
  });

  test('a custom token’s own peek stays on the custom segment', () => {
    expect(resolveTokenSegment('/v3/tokens/6f0f0e4c-1111-2222-3333-444455556666')).toBe('custom');
  });

  test('an unrelated path falls back rather than throwing', () => {
    expect(resolveTokenSegment('/v3/holdings')).toBe(DEFAULT_TOKEN_SEGMENT);
  });
});

describe('tokenSegmentPath', () => {
  test('round-trips every segment through its own path', () => {
    for (const entry of TOKEN_SEGMENTS) {
      expect(resolveTokenSegment(tokenSegmentPath(entry.key))).toBe(entry.key);
    }
  });
});

describe('hidden reasons', () => {
  test('says why in words, not in an enum value', () => {
    expect(hiddenReasonLabel(t, 'user_hidden')).toBe('Hidden by you');
    expect(hiddenReasonLabel(t, 'scam')).toBe('Flagged as a likely scam');
    expect(hiddenReasonLabel(t, 'both')).toBe('Flagged as a likely scam, and hidden by you');
  });

  test('“both” counts as scam-flagged, because un-flagging is still needed', () => {
    expect(isScamFlagged({ hiddenReason: 'both' })).toBe(true);
    expect(isScamFlagged({ hiddenReason: 'scam' })).toBe(true);
    expect(isScamFlagged({ hiddenReason: 'user_hidden' })).toBe(false);
  });
});

/**
 * The threshold moved out of `v2/components/ScamBadge.tsx` in SC-320 phase 3 —
 * v3's holdings total was importing a v2 React module to reach one number.
 * Pinned here because 0.35 is a product decision, not an implementation
 * detail: raising it hides real scams from the badge and puts their value back
 * into the reader's net worth.
 */
describe('isScamToken', () => {
  test('at the threshold counts, because the score is a lower bound', () => {
    expect(isScamToken(0.35)).toBe(true);
  });

  test('just under it does not', () => {
    expect(isScamToken(0.34)).toBe(false);
  });

  test('certainty either way is answered as asked', () => {
    expect(isScamToken(1)).toBe(true);
    expect(isScamToken(0)).toBe(false);
  });

  /** A token nobody has scored is not thereby a scam. */
  test('an unscored token is not a scam', () => {
    expect(isScamToken(null)).toBe(false);
    expect(isScamToken(undefined)).toBe(false);
  });
});

/**
 * `token_types.name`, which no locale file can reach (SC-419).
 *
 * The column holds English prose — "Fiat Currency", "Cryptocurrency" — seeded
 * into Postgres, and six languages ship rendering it verbatim in six places.
 * The fix is a map on the `code` beside it, so these tests are about two
 * different things and both have to hold: that a seeded code is TRANSLATED, and
 * that a code the map has never heard of degrades to something a reader can
 * still use.
 */
describe('tokenTypeLabel', () => {
  test('a seeded code renders the translated name, not the stored English', () => {
    // The stored name is deliberately different from the key's English here:
    // if the map were bypassed, `Crypto` would come back and this would fail.
    expect(tokenTypeLabel(t, 'crypto', 'Crypto')).toBe('Cryptocurrency');
    expect(tokenTypeLabel(t, 'fiat', 'Fiat Currency')).toBe('Fiat Currency');
    expect(tokenTypeLabel(t, 'private-company', 'Private Company')).toBe('Private Company');
  });

  /**
   * The assertion the whole ticket is about, on the thing that would be wrong.
   *
   * Asserting the English above only proves a lookup happened; a map wired to
   * the wrong instance, or a key absent from `ru.json`, both return the English
   * and pass. This one fails on either, because it asserts what a Russian
   * reader is SHOWN — and asserts it is not the English, so the i18next
   * fallback cannot satisfy it.
   */
  test('a Russian reader gets Russian, and the English fallback cannot satisfy it', () => {
    const ru = i18n.getFixedT('ru');
    expect(tokenTypeLabel(ru, 'crypto', 'Cryptocurrency')).toBe('Криптовалюта');
    expect(tokenTypeLabel(ru, 'fiat', 'Fiat Currency')).toBe('Фиатная валюта');
    expect(tokenTypeLabel(ru, 'crypto', 'Cryptocurrency')).not.toBe('Cryptocurrency');
  });

  /**
   * The must-be-ABSENT arm. `token_types` is a dynamic enum — rows, not a SQL
   * enum, and `schema/tokens.ts` says "Admin-extensible without a migration" —
   * so a code with no key is a state the shape allows. A map with no fallback
   * is how a sixth type ships as a blank label in a filter dropdown, which is
   * unpickable and says nothing.
   */
  test('an unknown code keeps the stored name rather than blanking', () => {
    expect(tokenTypeLabel(t, 'real-estate', 'Real Estate')).toBe('Real Estate');
  });

  test('an unknown code with no stored name degrades to the code, not to nothing', () => {
    expect(tokenTypeLabel(t, 'real-estate', null)).toBe('real-estate');
    expect(tokenTypeLabel(t, 'real-estate', '   ')).toBe('real-estate');
  });

  /** `tokens.getAll` left-joins `token_types`, so both halves can be null. */
  test('nothing to say is said as nothing, without throwing', () => {
    expect(tokenTypeLabel(t, null, null)).toBe('');
    expect(tokenTypeLabel(t, undefined, undefined)).toBe('');
    expect(tokenTypeLabel(t, '', '')).toBe('');
  });

  /**
   * The map against the seed, so a sixth seeded type cannot ship unlabelled.
   *
   * The fallback above means a new type degrades quietly rather than breaking,
   * which is the right runtime behaviour and exactly why nothing would report
   * it: the screen would show `Real Estate` in every language and no test would
   * fail. This is the arm that notices, and it reads the migrations themselves
   * rather than a copy of the list — the copy is the thing that goes stale.
   */
  test('every code the migrations seed has a key', () => {
    const dir = resolve(import.meta.dir, '../../../../../../packages/infra/db/src/migrations');
    const seeded = new Set<string>();
    let scanned = 0;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
      scanned += 1;
      const sql = readFileSync(join(dir, file), 'utf8');
      const insert = /INSERT INTO token_types\s*\(([^)]*)\)\s*VALUES([\s\S]*?);/gi;
      for (const statement of sql.matchAll(insert)) {
        const columns = (statement[1] ?? '').split(',').map((c) => c.trim().toLowerCase());
        // Only a seed that names `code` first is one this map is about; a
        // positional guess on some other column shape would invent codes.
        if (columns[0] !== 'code') continue;
        for (const row of (statement[2] ?? '').matchAll(/\(\s*'([^']+)'/g)) {
          seeded.add(row[1]!);
        }
      }
    }
    // The denominator, beside the result: a regex that stopped matching would
    // make this pass over an empty set, which is the one way it can lie.
    expect(scanned).toBeGreaterThan(20);
    expect([...seeded].sort()).toEqual(['crypto', 'fiat', 'other', 'private-company', 'stock']);

    const mapped = new Set(TOKEN_TYPE_LABELS.map((entry) => entry.code));
    expect([...seeded].filter((code) => !mapped.has(code))).toEqual([]);
  });

  /**
   * Every locale answers every key. `i18n-locales.test.ts` gates completeness
   * against `en.json` as a whole; this reads the five keys directly, so a
   * locale that is later exempted in `incomplete-locales.json` cannot take
   * these down with it silently.
   */
  test('all six shipped locales carry every type key', () => {
    const dir = resolve(import.meta.dir, '../../../src/v3/i18n/locales');
    const codes = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(codes.length).toBe(6);

    const missing: string[] = [];
    for (const file of codes) {
      const bundle = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>;
      for (const entry of TOKEN_TYPE_LABELS) {
        let node: unknown = bundle;
        for (const segment of entry.labelKey.split('.')) {
          node =
            typeof node === 'object' && node !== null
              ? (node as Record<string, unknown>)[segment]
              : undefined;
        }
        if (typeof node !== 'string' || node.trim() === '') {
          missing.push(`${file} -> ${entry.labelKey}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

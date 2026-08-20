import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import i18n from 'i18next';
import {
  DEFAULT_TOKEN_SEGMENT,
  hiddenReasonLabel,
  isScamFlagged,
  isScamToken,
  resolveTokenSegment,
  TOKEN_SEGMENTS,
  TOKENS_HIDDEN_PATH,
  tokenSegmentPath,
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

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_TOKEN_SEGMENT,
  hiddenReasonLabel,
  isScamFlagged,
  resolveTokenSegment,
  TOKEN_SEGMENTS,
  TOKENS_HIDDEN_PATH,
  tokenSegmentPath,
} from '../../../src/v3/lib/tokens';

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
    expect(hiddenReasonLabel('user_hidden')).toBe('Hidden by you');
    expect(hiddenReasonLabel('scam')).toBe('Flagged as a likely scam');
    expect(hiddenReasonLabel('both')).toBe('Flagged as a likely scam, and hidden by you');
  });

  test('“both” counts as scam-flagged, because un-flagging is still needed', () => {
    expect(isScamFlagged({ hiddenReason: 'both' })).toBe(true);
    expect(isScamFlagged({ hiddenReason: 'scam' })).toBe(true);
    expect(isScamFlagged({ hiddenReason: 'user_hidden' })).toBe(false);
  });
});

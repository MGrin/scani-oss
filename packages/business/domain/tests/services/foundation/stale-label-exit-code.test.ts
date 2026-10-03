import { describe, expect, test } from 'bun:test';
import { staleLabelExitCode } from '../../../src/services/foundation/stale-label-exit-code';

const LABEL = { entryId: 'a stale label' };
const FAILED = { userId: 'a user', error: 'its read failed' };

type Outcome = Parameters<typeof staleLabelExitCode>[0];

const RULED: Array<[string, Outcome, 0 | 1 | 2]> = [
  ['an apply that left nothing stale', { apply: true, stale: [], failedUsers: [] }, 0],
  ['an apply that left a label stale', { apply: true, stale: [LABEL], failedUsers: [] }, 2],
  [
    'an apply that left a label stale and lost a user: the failure takes precedence',
    { apply: true, stale: [LABEL], failedUsers: [FAILED] },
    1,
  ],
  ['an apply that lost a user', { apply: true, stale: [], failedUsers: [FAILED] }, 1],
  [
    'a dry run or a listing with stale labels: the list is what it was asked for',
    { apply: false, stale: [LABEL], failedUsers: [] },
    0,
  ],
  ['a dry run or a listing with none', { apply: false, stale: [], failedUsers: [] }, 0],
  [
    "a dry run or a listing where a user's read failed",
    { apply: false, stale: [LABEL], failedUsers: [FAILED] },
    1,
  ],
];

describe('staleLabelExitCode', () => {
  test.each(RULED)('%s exits as ruled', (_case, outcome, code) => {
    expect(staleLabelExitCode(outcome)).toBe(code);
  });
});

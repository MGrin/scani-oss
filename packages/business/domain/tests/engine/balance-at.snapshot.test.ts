import { describe, expect, test } from 'bun:test';
import { balanceAt } from '../../src/engine/balance-at';
import type { HoldingEvidence } from '../../src/engine/types';
import { checkpoint, derived, entry, evidence, snap, utc, verification } from './fixtures';

function balance(ev: HoldingEvidence, at: Date): string {
  return derived(balanceAt(ev, at)).balance.toString();
}

function reading(ev: HoldingEvidence, at: Date) {
  const result = balanceAt(ev, at);
  return result.status === 'absent' ? result : { ...result, balance: result.balance.toString() };
}

/** `superseded` marks each corrected predecessor the way the snapshot writer does. */
function correctedEvidence(superseded: boolean): HoldingEvidence {
  return evidence({
    observations: [
      snap('s1', utc('2026-01-10'), '100', superseded ? { supersededAt: utc('2026-01-20') } : {}),
      snap('c1', utc('2026-01-20'), '150', { cause: 'correction' }),
    ],
    entries: [entry('e1', utc('2026-01-15'), '1')],
  });
}

function chainedEvidence(superseded: boolean): HoldingEvidence {
  return evidence({
    observations: [
      snap('c2', utc('2026-01-25'), '140', { cause: 'correction' }),
      snap('c1', utc('2026-01-20'), '150', {
        cause: 'correction',
        ...(superseded ? { supersededAt: utc('2026-01-25') } : {}),
      }),
      snap('s1', utc('2026-01-10'), '100', superseded ? { supersededAt: utc('2026-01-20') } : {}),
    ],
  });
}

describe('balanceAt on a snapshot holding', () => {
  test('before starts_at the holding is absent', () => {
    const ev = evidence({ observations: [snap('s1', utc('2026-01-10'), '100')] });

    expect(balanceAt(ev, utc('2025-12-31'))).toEqual({ status: 'absent' });
  });

  test('latest snapshot plus entries since it', () => {
    const ev = evidence({
      observations: [snap('s1', utc('2026-01-10'), '100')],
      entries: [entry('e1', utc('2026-01-12'), '2', { kind: 'income' })],
    });

    const result = derived(balanceAt(ev, utc('2026-01-15')));

    expect(result.balance.toString()).toBe('102');
    expect(result.method).toBe('forward');
    expect(result.entriesApplied).toBe(1);
    expect(result.anchorId).toBe('s1');
    expect(result.anchorAt).toEqual(utc('2026-01-10'));
  });

  test('an entry at the anchor instant is already in the anchor', () => {
    const ev = evidence({
      observations: [snap('s1', utc('2026-01-10'), '100')],
      entries: [entry('e1', utc('2026-01-10'), '5')],
    });

    const result = derived(balanceAt(ev, utc('2026-01-15')));

    expect(result.balance.toString()).toBe('100');
    expect(result.entriesApplied).toBe(0);
  });

  test('before the first snapshot it applies unchanged', () => {
    const ev = evidence({
      observations: [snap('s1', utc('2026-01-10'), '100')],
      entries: [entry('e1', utc('2026-01-05'), '5')],
    });

    const result = derived(balanceAt(ev, utc('2026-01-03')));

    expect(result.balance.toString()).toBe('100');
    expect(result.method).toBe('first-snapshot');
    expect(result.anchorId).toBe('s1');
    expect(result.entriesApplied).toBe(0);
  });

  test('a newer snapshot resets the base', () => {
    const ev = evidence({
      observations: [
        snap('s2', utc('2026-01-20'), '80', { cause: 'growth' }),
        snap('s1', utc('2026-01-10'), '100'),
      ],
      entries: [entry('e1', utc('2026-01-15'), '5')],
    });

    expect(balance(ev, utc('2026-01-16'))).toBe('105');
    expect(balance(ev, utc('2026-01-25'))).toBe('80');
  });

  test('a correction applies from the anchor it supersedes, walking back over entries', () => {
    const ev = correctedEvidence(false);

    const walkedBack = derived(balanceAt(ev, utc('2026-01-12')));
    expect(walkedBack.balance.toString()).toBe('149');
    expect(walkedBack.method).toBe('walk-back');
    expect(walkedBack.anchorId).toBe('c1');
    expect(walkedBack.entriesApplied).toBe(1);

    expect(balance(ev, utc('2026-01-16'))).toBe('150');
    expect(balance(ev, utc('2026-01-25'))).toBe('150');
  });

  test('before a corrected window, the value is the window value at its start', () => {
    const ev = correctedEvidence(false);

    const before = derived(balanceAt(ev, utc('2026-01-09')));

    expect(before.balance.toString()).toBe('149');
    expect(before.method).toBe('first-snapshot');
    expect(before.anchorId).toBe('c1');
    expect(balance(ev, utc('2026-01-10'))).toBe(before.balance.toString());
  });

  test('a correction finds its predecessor among superseded rows', () => {
    const instants = ['01-05', '01-09', '01-10', '01-12', '01-16', '01-20', '01-25'].map((day) =>
      utc(`2026-${day}`)
    );
    for (const build of [correctedEvidence, chainedEvidence]) {
      for (const at of instants) {
        // `method` is what catches superseded rows filtered before the walk; the balances coincide.
        expect(reading(build(true), at)).toEqual(reading(build(false), at));
      }
    }
  });

  test('a correction that wins its instant over a superseded rival replaces the rival, not the anchor before it', () => {
    const ev = evidence({
      observations: [
        snap('s0', utc('2026-01-01'), '100'),
        snap('s1', utc('2026-01-10'), '200', { supersededAt: utc('2026-01-10') }),
        snap('c1', utc('2026-01-10'), '210', { cause: 'correction' }),
      ],
      entries: [entry('e1', utc('2026-01-03'), '1'), entry('e2', utc('2026-01-08'), '2')],
    });

    const untouched = derived(balanceAt(ev, utc('2026-01-05')));
    expect(untouched.balance.toString()).toBe('101');
    expect(untouched.anchorId).toBe('s0');

    const corrected = derived(balanceAt(ev, utc('2026-01-12')));
    expect(corrected.balance.toString()).toBe('210');
    expect(corrected.method).toBe('forward');
    expect(corrected.anchorId).toBe('c1');
  });

  test('a correction that beats a superseded correction at its instant takes over that correction window', () => {
    const ev = evidence({
      observations: [
        snap('s0', utc('2026-01-01'), '100'),
        snap('s1', utc('2026-01-10'), '200', { supersededAt: utc('2026-01-20') }),
        snap('c1', utc('2026-01-20'), '150', {
          cause: 'correction',
          supersededAt: utc('2026-01-20'),
        }),
        snap('c2', utc('2026-01-20'), '160', { cause: 'correction' }),
      ],
      entries: [entry('e1', utc('2026-01-15'), '1')],
    });

    const inherited = derived(balanceAt(ev, utc('2026-01-12')));
    expect(inherited.balance.toString()).toBe('159');
    expect(inherited.method).toBe('walk-back');
    expect(inherited.anchorId).toBe('c2');

    const untouched = derived(balanceAt(ev, utc('2026-01-05')));
    expect(untouched.balance.toString()).toBe('100');
    expect(untouched.anchorId).toBe('s0');
  });

  test('same instant, authority and recording: the higher id anchors', () => {
    const lower = snap('a', utc('2026-01-10'), '90');
    const higher = snap('b', utc('2026-01-10'), '95');

    for (const observations of [
      [lower, higher],
      [higher, lower],
    ]) {
      expect(balance(evidence({ observations }), utc('2026-01-11'))).toBe('95');
    }
  });

  test('within one instant an unsuperseded value beats a superseded one that outranks it', () => {
    const superseded = snap('z', utc('2026-01-10'), '90', {
      authority: 'provider',
      recordedAt: utc('2026-01-10', '11:00'),
      supersededAt: utc('2026-01-11'),
    });
    const current = snap('a', utc('2026-01-10'), '95', { recordedAt: utc('2026-01-10', '09:00') });

    for (const observations of [
      [superseded, current],
      [current, superseded],
    ]) {
      const result = derived(balanceAt(evidence({ observations }), utc('2026-01-12')));
      expect(result.balance.toString()).toBe('95');
      expect(result.anchorId).toBe('a');
    }
  });

  test('a correction with no earlier snapshot applies from starts_at', () => {
    const ev = evidence({
      observations: [snap('c1', utc('2026-01-20'), '150', { cause: 'correction' })],
      entries: [entry('e1', utc('2026-01-15'), '1')],
    });

    const result = derived(balanceAt(ev, utc('2026-01-05')));

    expect(result.balance.toString()).toBe('149');
    expect(result.method).toBe('walk-back');
  });

  test('chained corrections inherit the first window', () => {
    const ev = chainedEvidence(false);

    const result = derived(balanceAt(ev, utc('2026-01-12')));

    expect(result.balance.toString()).toBe('140');
    expect(result.method).toBe('walk-back');
    expect(result.anchorId).toBe('c2');
  });

  test('a superseded snapshot does not anchor', () => {
    const ev = evidence({
      observations: [
        snap('s1', utc('2026-01-10'), '100'),
        snap('s2', utc('2026-01-20'), '120', { supersededAt: utc('2026-01-21') }),
      ],
    });

    const result = derived(balanceAt(ev, utc('2026-01-25')));

    expect(result.balance.toString()).toBe('100');
    expect(result.anchorId).toBe('s1');
  });

  test('same instant, same authority: the later-recorded value anchors', () => {
    const earlier = snap('s2', utc('2026-01-10'), '90', { recordedAt: utc('2026-01-10', '09:00') });
    const later = snap('s1', utc('2026-01-10'), '95', { recordedAt: utc('2026-01-10', '10:00') });

    for (const observations of [
      [earlier, later],
      [later, earlier],
    ]) {
      expect(balance(evidence({ observations }), utc('2026-01-11'))).toBe('95');
    }
  });

  test('a checkpoint or a verification never anchors a snapshot holding', () => {
    const ev = evidence({
      observations: [
        snap('s1', utc('2026-01-10'), '100'),
        checkpoint('cp1', utc('2026-01-12'), '500'),
        verification('v1', utc('2026-01-13'), '600'),
      ],
    });

    const result = derived(balanceAt(ev, utc('2026-01-15')));

    expect(result.balance.toString()).toBe('100');
    expect(result.anchorId).toBe('s1');
  });

  test('mirror legs are entries like any other', () => {
    const ev = evidence({
      observations: [snap('s1', utc('2026-01-10'), '100')],
      entries: [entry('m1', utc('2026-01-12'), '7', { kind: 'transfer_in', kindOrigin: 'mirror' })],
    });

    expect(balance(ev, utc('2026-01-15'))).toBe('107');
  });
});

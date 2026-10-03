import { describe, expect, test } from 'bun:test';
import { balanceAt } from '../../src/engine/balance-at';
import type {
  HoldingEvidence,
  InputWindow,
  Observation,
  SnapshotCause,
} from '../../src/engine/types';
import {
  checkpoint,
  derived,
  entry,
  evidence,
  STARTS_AT,
  shuffled,
  snap,
  utc,
  verification,
} from './fixtures';

function feed(fields: Partial<HoldingEvidence> = {}): HoldingEvidence {
  return evidence({ kind: 'feed', ...fields });
}

function balance(ev: HoldingEvidence, at: Date): string {
  return derived(balanceAt(ev, at)).balance.toString();
}

/** The D7 setup: a snapshot before the feed window, and a snapshot-role value inside it. */
function mergeEvidence(
  windowInputId: string,
  insideCause: SnapshotCause = 'flow'
): HoldingEvidence {
  return feed({
    observations: [
      snap('s50', utc('2026-01-01'), '50'),
      checkpoint('cp100', utc('2026-01-20'), '100', { inputId: 'A' }),
      snap('s70', utc('2026-01-15'), '70', { cause: insideCause }),
    ],
    entries: [entry('e1', utc('2026-01-16'), '4')],
    windows: [{ inputId: windowInputId, from: utc('2026-01-10'), to: utc('2026-01-31') }],
  });
}

function reordered(ev: HoldingEvidence): HoldingEvidence[] {
  const reversed = {
    ...ev,
    observations: ev.observations.toReversed(),
    entries: ev.entries.toReversed(),
    windows: ev.windows.toReversed(),
  };
  const shuffles = [7, 1234, 99991].map((seed) => ({
    ...ev,
    observations: shuffled(ev.observations, seed),
    entries: shuffled(ev.entries, seed + 1),
    windows: shuffled(ev.windows, seed + 2),
  }));
  return [reversed, ...shuffles];
}

describe('balanceAt on a feed holding', () => {
  test('checkpoint plus entries since', () => {
    const ev = feed({
      observations: [checkpoint('cp1', utc('2026-01-10'), '100')],
      entries: [entry('e1', utc('2026-01-12'), '5'), entry('e2', utc('2026-01-15'), '-3')],
    });

    const result = derived(balanceAt(ev, utc('2026-01-20')));

    expect(result.balance.toString()).toBe('102');
    expect(result.method).toBe('forward');
    expect(result.entriesApplied).toBe(2);
    expect(result.anchorId).toBe('cp1');
  });

  test('before the first checkpoint, walk back', () => {
    const ev = feed({
      observations: [checkpoint('cp1', utc('2026-01-10'), '100')],
      entries: [entry('e1', utc('2026-01-05'), '30'), entry('e2', utc('2026-01-08'), '-10')],
    });

    const jan6 = derived(balanceAt(ev, utc('2026-01-06')));
    expect(jan6.balance.toString()).toBe('110');
    expect(jan6.method).toBe('walk-back');
    expect(jan6.anchorId).toBe('cp1');

    const jan4 = derived(balanceAt(ev, utc('2026-01-04')));
    expect(jan4.balance.toString()).toBe('80');
    expect(jan4.method).toBe('walk-back');
    expect(jan4.entriesApplied).toBe(2);
  });

  test('provider beats statement at the same instant', () => {
    const provider = checkpoint('cp-a', utc('2026-01-10'), '100');
    const statement = checkpoint('cp-b', utc('2026-01-10'), '90', {
      authority: 'statement',
      recordedAt: utc('2026-01-10', '12:00'),
    });

    for (const observations of [
      [provider, statement],
      [statement, provider],
    ]) {
      const result = derived(balanceAt(feed({ observations }), utc('2026-01-11')));
      expect(result.balance.toString()).toBe('100');
      expect(result.anchorId).toBe('cp-a');
    }
  });

  test('a person value on a feed holding is a verification and never anchors', () => {
    const ev = feed({
      observations: [
        checkpoint('cp1', utc('2026-01-10'), '100'),
        verification('v1', utc('2026-01-15'), '500'),
      ],
    });

    const result = derived(balanceAt(ev, utc('2026-01-20')));

    expect(result.balance.toString()).toBe('100');
    expect(result.anchorId).toBe('cp1');
  });

  test('an absence is a zero checkpoint', () => {
    const ev = feed({
      observations: [
        checkpoint('cp1', utc('2026-01-10'), '100'),
        checkpoint('cp0', utc('2026-01-15'), '0'),
      ],
    });

    const result = derived(balanceAt(ev, utc('2026-01-20')));

    expect(result.balance.toString()).toBe('0');
    expect(result.method).toBe('forward');
    expect(result.anchorId).toBe('cp0');
  });

  test('merge (D7): snapshots anchor before the feed window, checkpoints inside it', () => {
    const ev = mergeEvidence('A');

    expect(balance(ev, utc('2026-01-05'))).toBe('50');

    const inside = derived(balanceAt(ev, utc('2026-01-17')));
    expect(inside.balance.toString()).toBe('54');
    expect(inside.anchorId).toBe('s50');

    const after = derived(balanceAt(ev, utc('2026-01-25')));
    expect(after.balance.toString()).toBe('100');
    expect(after.anchorId).toBe('cp100');
  });

  test('merge (D7): where the feed carries no balances, snapshots keep anchoring', () => {
    const ev = mergeEvidence('B');

    const inside = derived(balanceAt(ev, utc('2026-01-17')));
    expect(inside.balance.toString()).toBe('74');
    expect(inside.anchorId).toBe('s70');

    const after = derived(balanceAt(ev, utc('2026-01-25')));
    expect(after.balance.toString()).toBe('100');
    expect(after.anchorId).toBe('cp100');
  });

  test('merge (D7): a correction inside a balance-carrying window neither opens nor takes over a window', () => {
    const ev = mergeEvidence('A', 'correction');

    const before = derived(balanceAt(ev, utc('2026-01-05')));
    expect(before.balance.toString()).toBe('50');
    expect(before.method).toBe('forward');
    expect(before.anchorId).toBe('s50');

    const inside = derived(balanceAt(ev, utc('2026-01-17')));
    expect(inside.balance.toString()).toBe('54');
    expect(inside.anchorId).toBe('s50');

    expect(balance(ev, utc('2026-01-25'))).toBe('100');
  });

  test('merge (D7): a window carries balances only through its own checkpoint inside it', () => {
    const ev = feed({
      observations: [
        snap('s50', utc('2026-01-05'), '50'),
        checkpoint('cp-a', utc('2026-01-08'), '100', { inputId: 'A' }),
        snap('s70', utc('2026-01-15'), '70'),
        checkpoint('cp-b', utc('2026-02-05'), '200', { inputId: 'B' }),
      ],
      entries: [entry('e1', utc('2026-01-16'), '4')],
      windows: [
        { inputId: 'A', from: null, to: utc('2026-01-10') },
        { inputId: 'B', from: utc('2026-01-12'), to: utc('2026-01-31') },
      ],
    });

    const openStart = derived(balanceAt(ev, utc('2026-01-06')));
    expect(openStart.balance.toString()).toBe('100');
    expect(openStart.anchorId).toBe('cp-a');

    const checkpointOutside = derived(balanceAt(ev, utc('2026-01-17')));
    expect(checkpointOutside.balance.toString()).toBe('74');
    expect(checkpointOutside.anchorId).toBe('s70');
  });

  test('merge (D7): a superseded checkpoint still marks its window as carrying balances', () => {
    const ev = feed({
      observations: [
        snap('s50', utc('2026-01-01'), '50'),
        checkpoint('cp100', utc('2026-01-20'), '100', {
          inputId: 'A',
          supersededAt: utc('2026-01-22'),
        }),
        snap('s70', utc('2026-01-15'), '70'),
      ],
      entries: [entry('e1', utc('2026-01-16'), '4')],
      windows: [{ inputId: 'A', from: utc('2026-01-10'), to: utc('2026-01-31') }],
    });

    const result = derived(balanceAt(ev, utc('2026-01-17')));

    expect(result.balance.toString()).toBe('54');
    expect(result.anchorId).toBe('s50');
  });

  test('merge (D7): a snapshot exactly at the start or the end of a carrying window does not anchor', () => {
    const ev = feed({
      observations: [
        snap('s50', utc('2026-01-01'), '50'),
        snap('s60', utc('2026-01-10'), '60'),
        checkpoint('cp100', utc('2026-01-20'), '100', { inputId: 'A' }),
        snap('s80', utc('2026-01-31'), '80'),
      ],
      entries: [entry('e1', utc('2026-01-16'), '4')],
      windows: [{ inputId: 'A', from: utc('2026-01-10'), to: utc('2026-01-31') }],
    });

    const atStart = derived(balanceAt(ev, utc('2026-01-12')));
    expect(atStart.balance.toString()).toBe('50');
    expect(atStart.anchorId).toBe('s50');

    const atEnd = derived(balanceAt(ev, utc('2026-02-02')));
    expect(atEnd.balance.toString()).toBe('100');
    expect(atEnd.anchorId).toBe('cp100');
  });

  test('before a snapshot-role first anchor, a feed holding walks back', () => {
    const ev = feed({
      observations: [snap('s50', utc('2026-01-10'), '50')],
      entries: [entry('e1', utc('2026-01-05'), '5')],
    });

    const result = derived(balanceAt(ev, utc('2026-01-03')));

    expect(result.balance.toString()).toBe('45');
    expect(result.method).toBe('walk-back');
    expect(result.anchorId).toBe('s50');
  });

  test('a person correction never takes over a checkpoint window', () => {
    const ev = feed({
      observations: [
        checkpoint('cp-s', utc('2026-01-10'), '100', { inputId: 'S', authority: 'statement' }),
        snap('c1', utc('2026-02-01'), '500', { cause: 'correction' }),
      ],
      entries: [entry('e1', utc('2026-01-20'), '5')],
      windows: [{ inputId: 'S', from: utc('2026-01-01'), to: utc('2026-01-10') }],
    });

    const atCheckpoint = derived(balanceAt(ev, utc('2026-01-10')));
    expect(atCheckpoint.balance.toString()).toBe('100');
    expect(atCheckpoint.method).toBe('forward');
    expect(atCheckpoint.anchorId).toBe('cp-s');

    expect(balance(ev, utc('2026-01-20'))).toBe('105');

    const corrected = derived(balanceAt(ev, utc('2026-02-01')));
    expect(corrected.balance.toString()).toBe('500');
    expect(corrected.method).toBe('forward');
    expect(corrected.anchorId).toBe('c1');
  });

  test('on a feed holding a correction still takes over a snapshot window', () => {
    const ev = feed({
      observations: [
        snap('s50', utc('2026-01-05'), '50'),
        snap('c60', utc('2026-01-15'), '60', { cause: 'correction' }),
      ],
      entries: [entry('e1', utc('2026-01-10'), '1')],
    });

    const result = derived(balanceAt(ev, utc('2026-01-07')));

    expect(result.balance.toString()).toBe('59');
    expect(result.method).toBe('walk-back');
    expect(result.anchorId).toBe('c60');
  });

  test('a cause on a checkpoint is ignored, so it never takes over a snapshot window', () => {
    const ev = feed({
      observations: [
        snap('s50', utc('2026-01-05'), '50'),
        checkpoint('cp60', utc('2026-01-15'), '60', { cause: 'correction' }),
      ],
      entries: [entry('e1', utc('2026-01-10'), '1')],
    });

    const before = derived(balanceAt(ev, utc('2026-01-07')));
    expect(before.balance.toString()).toBe('50');
    expect(before.method).toBe('forward');
    expect(before.anchorId).toBe('s50');

    expect(balance(ev, utc('2026-01-16'))).toBe('60');
  });

  test('a superseded checkpoint marked as a correction is a plain rival at its instant', () => {
    const ev = feed({
      observations: [
        snap('s50', utc('2026-01-05'), '50'),
        checkpoint('cp70', utc('2026-01-15'), '70', {
          cause: 'correction',
          supersededAt: utc('2026-01-15'),
        }),
        snap('c60', utc('2026-01-15'), '60', { cause: 'correction' }),
      ],
      entries: [entry('e1', utc('2026-01-10'), '1')],
    });

    const result = derived(balanceAt(ev, utc('2026-01-07')));

    expect(result.balance.toString()).toBe('50');
    expect(result.method).toBe('forward');
    expect(result.anchorId).toBe('s50');
  });

  test('REVIEW FOCUS 5: no evidence at all derives zero', () => {
    const result = derived(balanceAt(feed(), utc('2026-01-10')));

    expect(result.balance.toString()).toBe('0');
    expect(result.method).toBe('no-anchor');
    expect(result.anchorId).toBeNull();
    expect(result.entriesApplied).toBe(0);
  });

  test('no anchor: entries from starts_at on', () => {
    const ev = feed({
      entries: [
        entry('e0', utc('2025-12-31'), '1000'),
        entry('e1', utc('2026-01-05'), '10'),
        entry('e2', utc('2026-01-07'), '5'),
      ],
    });

    const result = derived(balanceAt(ev, utc('2026-01-10')));

    expect(result.balance.toString()).toBe('15');
    expect(result.method).toBe('no-anchor');
    expect(result.entriesApplied).toBe(2);
  });

  test('replay: the same evidence in any order gives an identical result', () => {
    const feedEvidence = feed({
      observations: [
        snap('s50', utc('2026-01-01'), '50'),
        snap('s70', utc('2026-01-15'), '70'),
        checkpoint('cp-p', utc('2026-01-20'), '100', { inputId: 'A' }),
        checkpoint('cp-s', utc('2026-01-20'), '90', { inputId: 'A', authority: 'statement' }),
        verification('v1', utc('2026-01-22'), '500'),
        checkpoint('cp0', utc('2026-01-28'), '0', { inputId: 'A' }),
      ],
      entries: [
        entry('e1', utc('2026-01-05'), '30'),
        entry('e2', utc('2026-01-08'), '-10'),
        entry('e3', utc('2026-01-16'), '4'),
        // Summed in a different order these round to 0 or to 1 at Decimal's precision.
        entry('e4', utc('2026-01-21'), '1000000000000000000000000000000'),
        entry('e5', utc('2026-01-21'), '1'),
        entry('e6', utc('2026-01-21'), '-1000000000000000000000000000000'),
      ],
      windows: [
        { inputId: 'A', from: utc('2026-01-10'), to: utc('2026-01-31') },
        { inputId: 'B', from: null, to: utc('2026-01-09') },
      ],
    });
    const snapshotEvidence = evidence({
      observations: [
        snap('s0', utc('2026-01-01'), '100'),
        snap('s1', utc('2026-01-10'), '200', { supersededAt: utc('2026-01-10') }),
        snap('c1', utc('2026-01-10'), '210', { cause: 'correction' }),
        snap('a', utc('2026-01-20'), '90'),
        snap('b', utc('2026-01-20'), '95'),
        checkpoint('cp1', utc('2026-01-21'), '500'),
        snap('c2', utc('2026-01-25'), '140', { cause: 'correction' }),
      ],
      entries: [
        entry('e1', utc('2026-01-03'), '1'),
        entry('e2', utc('2026-01-08'), '2'),
        entry('e3', utc('2026-01-15'), '1'),
        entry('e4', utc('2026-01-22'), '7', { kind: 'transfer_in', kindOrigin: 'mirror' }),
      ],
    });
    const cases = [
      { ev: feedEvidence, instants: ['01-03', '01-09', '01-17', '01-21', '01-30'] },
      { ev: snapshotEvidence, instants: ['01-05', '01-12', '01-20', '01-23', '01-28'] },
    ];

    for (const { ev, instants } of cases) {
      for (const day of instants) {
        const at = utc(`2026-${day}`);
        const original = balanceAt(ev, at);
        expect(original.status).toBe('derived');
        for (const variant of reordered(ev)) {
          expect(balanceAt(variant, at)).toEqual(original);
        }
      }
    }
  });
});

/**
 * The anchor on 16 January, a day after a snapshot-role value. It is that
 * value (`s70`) unless a window carrying balances covers it.
 */
function anchorAfterS70(
  windows: readonly InputWindow[],
  checkpoints: readonly Observation[]
): string | null {
  const ev = feed({
    observations: [
      snap('s50', utc('2026-01-01'), '50'),
      snap('s70', utc('2026-01-15'), '70'),
      ...checkpoints,
    ],
    windows,
  });
  return derived(balanceAt(ev, utc('2026-01-16'))).anchorId;
}

describe('which windows carry balances (D7)', () => {
  const window = (inputId: string): InputWindow => ({
    inputId,
    from: utc('2026-01-10'),
    to: utc('2026-01-20'),
  });

  test('a checkpoint exactly on its window start is inside it, a minute earlier is not', () => {
    const onStart = checkpoint('cp', utc('2026-01-10'), '100', { inputId: 'A' });
    const justBefore = checkpoint('cp', utc('2026-01-09', '23:59'), '100', { inputId: 'A' });

    expect(anchorAfterS70([window('A')], [onStart])).toBe('cp');
    expect(anchorAfterS70([window('A')], [justBefore])).toBe('s70');
  });

  test('a checkpoint exactly on its window end is inside it, a minute later is not', () => {
    const onEnd = checkpoint('cp', utc('2026-01-20'), '100', { inputId: 'A' });
    const justAfter = checkpoint('cp', utc('2026-01-20', '00:01'), '100', { inputId: 'A' });

    expect(anchorAfterS70([window('A')], [onEnd])).toBe('s50');
    expect(anchorAfterS70([window('A')], [justAfter])).toBe('s70');
  });

  test('an open-start window reaches back to any earlier checkpoint, and to none after its end', () => {
    const openStart: InputWindow = { inputId: 'A', from: null, to: utc('2026-01-20') };
    const early = checkpoint('cp-early', utc('2026-01-03'), '100', { inputId: 'A' });
    const afterEnd = checkpoint('cp-late', utc('2026-01-25'), '100', { inputId: 'A' });

    expect(anchorAfterS70([openStart], [early])).toBe('cp-early');
    expect(anchorAfterS70([openStart], [afterEnd, early])).toBe('cp-early');
    expect(anchorAfterS70([openStart], [afterEnd])).toBe('s70');
  });

  test('where two inputs interleave, a window counts only checkpoints of its own input', () => {
    const interleaved = [
      checkpoint('cp-a1', utc('2026-01-05'), '100', { inputId: 'A' }),
      checkpoint('cp-b1', utc('2026-01-12'), '200', { inputId: 'B' }),
      checkpoint('cp-a2', utc('2026-01-25'), '300', { inputId: 'A' }),
      checkpoint('cp-b2', utc('2026-01-30'), '400', { inputId: 'B' }),
    ];

    for (const checkpoints of [
      interleaved,
      ...[7, 1234, 99991].map((s) => shuffled(interleaved, s)),
    ]) {
      expect(anchorAfterS70([window('A')], checkpoints)).toBe('s70');
      expect(anchorAfterS70([window('B')], checkpoints)).toBe('cp-b1');
      expect(anchorAfterS70([window('A'), window('B')], checkpoints)).toBe('cp-b1');
    }
  });

  test('a window in a gap between its own checkpoints carries nothing, however many lie either side', () => {
    const days = ['02', '04', '06', '08', '22', '24', '26', '28'];
    const around = days.map((day) =>
      checkpoint(`cp-${day}`, utc(`2026-01-${day}`), '100', { inputId: 'A' })
    );
    const inside = checkpoint('cp-18', utc('2026-01-18'), '100', { inputId: 'A' });

    for (const seed of [7, 1234, 99991]) {
      expect(anchorAfterS70([window('A')], shuffled(around, seed))).toBe('s70');
      expect(anchorAfterS70([window('A')], shuffled([...around, inside], seed))).toBe('cp-08');
    }
  });

  test('an input with windows and no checkpoint of its own carries nothing', () => {
    const otherInput = checkpoint('cp-a', utc('2026-01-12'), '100', { inputId: 'A' });
    const noInput = checkpoint('cp-none', utc('2026-01-13'), '100');

    expect(anchorAfterS70([window('C')], [])).toBe('s70');
    expect(anchorAfterS70([window('C')], [otherInput, noInput])).toBe('s70');
  });

  test('a checkpoint with an invalid date carries nothing and does not hide the others of its input', () => {
    const invalid = checkpoint('cp-invalid', new Date(Number.NaN), '100', { inputId: 'A' });
    const onEnd = checkpoint('cp', utc('2026-01-20'), '100', { inputId: 'A' });
    const before = checkpoint('cp-before', utc('2026-01-05'), '100', { inputId: 'A' });

    expect(anchorAfterS70([window('A')], [invalid])).toBe('s70');
    expect(anchorAfterS70([window('A')], [invalid, onEnd])).toBe('s50');
    expect(anchorAfterS70([window('A')], [onEnd, invalid])).toBe('s50');
    expect(anchorAfterS70([window('A')], [before, invalid, onEnd])).toBe('cp-before');
  });
});

interface CarryingWindow {
  window: InputWindow;
  closing: Observation;
}

/** A window that carries balances: a checkpoint of its own input sits on its last instant. */
function carrying(inputId: string, from: Date | null, to: Date, id = `cp-${inputId}`) {
  return { window: { inputId, from, to }, closing: checkpoint(id, to, '100', { inputId }) };
}

function anchorAfterS70Among(
  covering: readonly CarryingWindow[],
  others: readonly InputWindow[] = []
): string | null {
  return anchorAfterS70(
    [...covering.map((c) => c.window), ...others],
    covering.map((c) => c.closing)
  );
}

describe('which snapshot-role values a carrying window covers (D7)', () => {
  test('a value a minute outside a carrying window anchors, on either side', () => {
    const startsAMinuteAfter = carrying('A', utc('2026-01-15', '00:01'), utc('2026-01-25'));
    const startsOnIt = carrying('A', utc('2026-01-15'), utc('2026-01-25'));
    const endsAMinuteBefore = carrying('A', utc('2026-01-05'), utc('2026-01-14', '23:59'));
    const endsOnIt = carrying('A', utc('2026-01-05'), utc('2026-01-15'));

    expect(anchorAfterS70Among([startsAMinuteAfter])).toBe('s70');
    expect(anchorAfterS70Among([startsOnIt])).toBe('s50');
    expect(anchorAfterS70Among([endsAMinuteBefore])).toBe('s70');
    expect(anchorAfterS70Among([endsOnIt])).toBe('cp-A');
  });

  test('a short carrying window inside a long one does not cut the long one short', () => {
    const long = carrying('A', utc('2026-01-05'), utc('2026-01-25'));
    const short = carrying('B', utc('2026-01-08'), utc('2026-01-10'));

    expect(anchorAfterS70Among([long, short])).toBe('cp-B');
    expect(anchorAfterS70Among([short, long])).toBe('cp-B');
    expect(anchorAfterS70Among([short])).toBe('s70');
  });

  test('a value in the gap between two carrying windows anchors until a carrying window bridges it', () => {
    const before = carrying('A', utc('2026-01-05'), utc('2026-01-12'));
    const after = carrying('B', utc('2026-01-18'), utc('2026-01-25'));
    const bridge = carrying('C', utc('2026-01-12'), utc('2026-01-18'));
    const emptyBridge: InputWindow = {
      inputId: 'D',
      from: utc('2026-01-12'),
      to: utc('2026-01-18'),
    };

    expect(anchorAfterS70Among([before, after])).toBe('s70');
    expect(anchorAfterS70Among([before, after], [emptyBridge])).toBe('s70');
    expect(anchorAfterS70Among([after, bridge, before])).toBe('cp-A');
  });

  test('open-start carrying windows of two inputs cover everything up to the later end', () => {
    const untilTheTenth = carrying('A', null, utc('2026-01-10'));
    const untilTheTwentieth = carrying('B', null, utc('2026-01-20'));

    expect(anchorAfterS70Among([untilTheTenth])).toBe('s70');
    expect(anchorAfterS70Among([untilTheTenth, untilTheTwentieth])).toBe('cp-A');
    expect(anchorAfterS70Among([untilTheTwentieth, untilTheTenth])).toBe('cp-A');
  });

  test('among many carrying windows in any order, only one over the value covers it', () => {
    const elsewhere = [
      ['02', '03'],
      ['06', '07'],
      ['10', '11'],
      ['19', '20'],
      ['23', '24'],
      ['27', '28'],
    ].map(([from, to]) => carrying('A', utc(`2026-01-${from}`), utc(`2026-01-${to}`), `cp-${to}`));
    const over = carrying('B', utc('2026-01-13'), utc('2026-01-17'));

    for (const seed of [7, 1234, 99991]) {
      expect(anchorAfterS70Among(shuffled(elsewhere, seed))).toBe('s70');
      expect(anchorAfterS70Among(shuffled([...elsewhere, over], seed))).toBe('cp-11');
    }
  });
});

const HOUR_MS = 3_600_000;
const fetchedAt = (fetch: number) => new Date(STARTS_AT.getTime() + fetch * HOUR_MS);

/**
 * What an hourly feed accumulates: one window per fetch, closed by that fetch's
 * checkpoint. The values typed before it began are what a manual holding brings
 * along when it gains a feed.
 */
function hourlyFeed(fetches: number, valuesTypedBefore = 0): HoldingEvidence {
  const indexes = Array.from({ length: fetches }, (_, index) => index);
  const typed = Array.from({ length: valuesTypedBefore }, (_, index) => index);
  return feed({
    observations: [
      ...typed.map((i) => snap(`s${i}`, fetchedAt(-1 - i), String(i))),
      ...indexes.map((i) => checkpoint(`cp${i}`, fetchedAt(i + 1), String(i), { inputId: 'A' })),
    ],
    windows: indexes.map((i) => ({ inputId: 'A', from: fetchedAt(i), to: fetchedAt(i + 1) })),
  });
}

function elapsedMs(run: () => void): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

/**
 * How many times longer `large` takes than ten runs of `small`, which is a
 * tenth of its size: about 1 while the cost grows in step with the evidence,
 * about 10 once it grows with its square.
 *
 * A ratio and not a duration, because this box runs at several times its core
 * count and an absolute bound there measures the neighbours. The two samples do
 * the same amount of work and alternate, so a slow stretch falls on both; each
 * runs once unmeasured first, so neither is timed cold.
 */
function costOfTenfold(small: HoldingEvidence, large: HoldingEvidence, at: Date): number {
  const smallTenTimes = () => {
    for (let run = 0; run < 10; run++) balanceAt(small, at);
  };
  const largeOnce = () => {
    balanceAt(large, at);
  };
  smallTenTimes();
  largeOnce();

  let fastestSmall = Number.POSITIVE_INFINITY;
  let fastestLarge = Number.POSITIVE_INFINITY;
  for (let round = 0; round < 5; round++) {
    fastestSmall = Math.min(fastestSmall, elapsedMs(smallTenTimes));
    fastestLarge = Math.min(fastestLarge, elapsedMs(largeOnce));
  }
  return fastestLarge / fastestSmall;
}

describe('balanceAt as windows accumulate', () => {
  test('ten times the windows and checkpoints on one input cost about ten times as long', () => {
    const small = hourlyFeed(500);
    const at = fetchedAt(5_001);

    const result = derived(balanceAt(small, at));
    expect(result.anchorId).toBe('cp499');
    expect(result.balance.toString()).toBe('499');

    expect(costOfTenfold(small, hourlyFeed(5_000), at)).toBeLessThan(3);
  });

  test('ten times the windows and ten times the values typed before them cost about ten times as long', () => {
    const small = hourlyFeed(500, 50);
    const at = fetchedAt(5_001);

    const result = derived(balanceAt(small, at));
    expect(result.anchorId).toBe('cp499');
    expect(result.balance.toString()).toBe('499');
    expect(derived(balanceAt(small, fetchedAt(0))).anchorId).toBe('s0');

    expect(costOfTenfold(small, hourlyFeed(5_000, 500), at)).toBeLessThan(3);
  });
});

import { describe, expect, test } from 'bun:test';
import Decimal from 'decimal.js';
import { balanceAt } from '../../../src/engine/balance-at';
import type { HoldingEvidence } from '../../../src/engine/types';
import {
  asLedgerRows,
  DRIFT_GROWTH_KIND,
  DRIFT_IN_KIND,
  DRIFT_OUT_KIND,
  type DriftRow,
  driftRows,
  isOpeningArrival,
} from '../../../src/lib/balances/drift-rows';
import { checkpoint, entry, evidence, snap, verification } from '../../engine/fixtures';

type Reading = [at: string, balance: string, gapReview?: string];
type LedgerRow = [at: string, quantity: string];

interface Case {
  readings: Reading[];
  ledger?: LedgerRow[];
  /** Ledger rows the engine leaves out of the holding's entries. */
  excluded?: LedgerRow[];
  kind?: 'feed' | 'snapshot';
  /** Readings the engine does not anchor on, as a person's verification. */
  verifications?: Reading[];
  /** The holding's creation, when it is earlier than its first record. */
  createdAt?: string;
  /** The token's first stored price (SC-1638). */
  pricedFrom?: string;
}

function build(c: Case): {
  ev: HoldingEvidence;
  ledger: { occurredAt: Date; quantity: string }[];
  gaps: Map<string, string | null>;
} {
  const kind = c.kind ?? 'feed';
  const anchor = kind === 'snapshot' ? snap : checkpoint;
  const observations = [
    ...c.readings.map(([at, amount], i) => anchor(`o${i}`, new Date(at), amount)),
    ...(c.verifications ?? []).map(([at, amount], i) =>
      verification(`v${i}`, new Date(at), amount)
    ),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
  const entries = (c.ledger ?? []).map(([at, q], i) => entry(`e${i}`, new Date(at), q));
  const ledger = [...(c.ledger ?? []), ...(c.excluded ?? [])].map(([at, quantity]) => ({
    occurredAt: new Date(at),
    quantity,
  }));
  const starts = [
    ...observations.map((o) => o.at),
    ...entries.map((e) => e.at),
    ...(c.createdAt ? [new Date(c.createdAt)] : []),
  ];
  const startsAt = new Date(Math.min(...starts.map((d) => d.getTime())));
  const gaps = new Map(c.readings.map(([, , review], i) => [`o${i}`, review ?? null]));
  return { ev: evidence({ kind, startsAt, observations, entries }), ledger, gaps };
}

const pricedFromOf = (c: Case) => (c.pricedFrom ? new Date(c.pricedFrom) : null);
const rowsOf = (c: Case) => {
  const { ev, ledger, gaps } = build(c);
  return driftRows({ holdingId: 'h', tokenId: 'USD' }, ev, ledger, gaps, pricedFromOf(c));
};
const shape = (rows: DriftRow[]) =>
  rows.map((r) => [r.kind, r.quantity, r.occurredAt.toISOString()]);

describe('an unexplained balance change becomes rows that follow the engine (SC-1470, SC-1637)', () => {
  test('an unanswered drop is money out, booked whole where the engine takes it', () => {
    const rows = rowsOf({
      readings: [
        ['2026-05-01T12:00:00Z', '1000'],
        ['2026-05-03T12:00:00Z', '400'],
      ],
      ledger: [['2026-04-01T00:00:00Z', '1000']],
    });
    // SC-1637: no longer cut at 05-01 and 05-02 day ends; the value series
    // holds 1000 until the reading that reveals the drop.
    expect(shape(rows)).toEqual([[DRIFT_OUT_KIND, '-600', '2026-05-03T12:00:00.000Z']]);
  });

  test('only what the ledger does not explain', () => {
    const rows = rowsOf({
      readings: [
        ['2026-05-01T00:00:00Z', '100'],
        ['2026-05-04T00:00:00Z', '200'],
      ],
      ledger: [
        ['2026-05-02T10:00:00Z', '70'],
        ['2026-05-01T00:00:00Z', '100'],
      ],
    });
    // 200 − 100 − 70; the 100 sits on the first reading, so it explains the opening instead.
    expect(shape(rows)).toEqual([[DRIFT_IN_KIND, '30', '2026-05-04T00:00:00.000Z']]);
  });

  test('"unknown" is still money in or out', () => {
    const rows = rowsOf({
      readings: [
        ['2026-05-01T12:00:00Z', '0'],
        ['2026-05-01T18:00:00Z', '50', 'unknown'],
      ],
    });
    expect(rows.map((r) => [r.kind, r.quantity])).toEqual([[DRIFT_IN_KIND, '50']]);
  });

  test('an owner\'s "growth" answer stays gain', () => {
    const rows = rowsOf({
      readings: [
        ['2026-05-01T12:00:00Z', '100'],
        ['2026-05-01T18:00:00Z', '104', 'growth'],
      ],
      ledger: [['2026-04-01T00:00:00Z', '100']],
    });
    expect(rows.map((r) => [r.kind, r.quantity])).toEqual([[DRIFT_GROWTH_KIND, '4']]);
  });

  test('a holding with no ledger opens as money in just before its first reading, ahead of any gap', () => {
    const rows = rowsOf({
      readings: [
        ['2026-05-01T09:00:00Z', '41648.49'],
        ['2026-05-01T21:00:00Z', '22379.37'],
      ],
    });
    expect(shape(rows)).toEqual([
      [DRIFT_IN_KIND, '41648.49', '2026-05-01T08:59:59.999Z'],
      [DRIFT_OUT_KIND, '-19269.12', '2026-05-01T21:00:00.000Z'],
    ]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });

  test('a ledger that starts later than the money still opens with what it leaves unexplained', () => {
    // Edge Capital after the owner's withdrawal answer: the ledger's one row
    // is after the first reading, so the 41,749.85 it opened with is still
    // nobody's transaction.
    const rows = rowsOf({
      readings: [
        ['2026-05-17T15:07:54Z', '41749.85'],
        ['2026-07-27T23:47:01Z', '22174.58'],
      ],
      ledger: [['2026-07-27T23:47:01Z', '-19575.27']],
    });
    expect(rows.map((r) => [r.kind, r.quantity])).toEqual([[DRIFT_IN_KIND, '41749.85']]);
  });

  test("the opening is never booked before the first record's own day", () => {
    const rows = rowsOf({ readings: [['2026-05-01T00:00:00Z', '5']] });
    expect(rows[0]?.occurredAt.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });

  test('control: a ledger that explains the first reading opens with nothing', () => {
    const rows = rowsOf({
      readings: [['2026-05-03T00:00:00Z', '50']],
      ledger: [
        ['2026-05-01T00:00:00Z', '30'],
        ['2026-05-02T00:00:00Z', '20'],
      ],
    });
    expect(rows).toHaveLength(0);
  });

  test('only a positive opening is an opening arrival, the row a walk meets first (A5)', () => {
    const arrivals = (c: Case) =>
      asLedgerRows(rowsOf(c), 'u').map((row) => [row.kind, row.quantity, isOpeningArrival(row)]);
    // Opens with 5, then a gap adds 3 in one row at the reading: only the opening is one.
    expect(
      arrivals({
        readings: [
          ['2026-05-01T12:00:00Z', '5'],
          ['2026-05-02T12:00:00Z', '8'],
        ],
      })
    ).toEqual([
      [DRIFT_IN_KIND, '5', true],
      [DRIFT_IN_KIND, '3', false],
    ]);
    // A ledger that explains more than the first reading opens negative, which
    // leaves after the rows that brought it, not before them.
    expect(
      arrivals({
        readings: [['2026-05-01T12:00:00Z', '5']],
        ledger: [['2026-05-01T00:00:00Z', '7']],
      })
    ).toEqual([[DRIFT_OUT_KIND, '-2', false]]);
  });

  test('control: a gap and an opening the ledger explains make no rows', () => {
    expect(
      rowsOf({
        readings: [
          ['2026-05-01T00:00:00Z', '100'],
          ['2026-05-02T00:00:00Z', '150'],
        ],
        ledger: [
          ['2026-04-01T00:00:00Z', '100'],
          ['2026-05-01T12:00:00Z', '50'],
        ],
      })
    ).toHaveLength(0);
  });

  test('a reading the engine does not anchor on books no drift (SC-1637)', () => {
    const rows = rowsOf({
      readings: [
        ['2026-05-01T12:00:00Z', '100'],
        ['2026-05-03T12:00:00Z', '100'],
      ],
      verifications: [['2026-05-02T12:00:00Z', '150']],
    });
    expect(rows.map((r) => [r.kind, r.quantity])).toEqual([[DRIFT_IN_KIND, '100']]);
  });

  test('a stored opening the engine leaves out, before startsAt, is explained by the opening (SC-1637)', () => {
    const rows = rowsOf({
      readings: [['2026-05-02T12:00:00Z', '8']],
      excluded: [['2026-05-01T09:00:00Z', '5']],
    });
    // 8 − 5, booked before the stored row as the old opening was, never a
    // drift pair that re-buys the 5 at market.
    expect(shape(rows)).toEqual([[DRIFT_IN_KIND, '3', '2026-05-01T08:59:59.999Z']]);
  });

  test("an opening waits for the token's first price, and explains every row before it (SC-1638)", () => {
    const created = {
      kind: 'snapshot' as const,
      createdAt: '2026-05-01T00:00:00Z',
      readings: [['2026-05-10T12:00:00Z', '10']] satisfies Reading[],
      ledger: [['2026-05-03T09:00:00Z', '4']] satisfies LedgerRow[],
    };
    // Valued from creation, and priced from 05-05: the opening is booked
    // there, at what the ledger leaves unexplained by then, never at a cost of 0.
    expect(shape(rowsOf({ ...created, pricedFrom: '2026-05-05T00:00:00Z' }))).toEqual([
      [DRIFT_IN_KIND, '6', '2026-05-05T00:00:00.000Z'],
    ]);
    expect(
      isOpeningArrival(
        asLedgerRows(rowsOf({ ...created, pricedFrom: '2026-05-05T00:00:00Z' }), 'u')[0] as never
      )
    ).toBe(true);
    // Control: priced before creation, the opening stays at creation, at the
    // 10 the snapshot holds back to it, and the row the snapshot overrides is undone.
    expect(shape(rowsOf({ ...created, pricedFrom: '2026-04-01T00:00:00Z' }))).toEqual([
      [DRIFT_IN_KIND, '10', '2026-05-01T00:00:00.000Z'],
      [DRIFT_OUT_KIND, '-4', '2026-05-03T09:00:00.000Z'],
    ]);
  });

  test('a ledger row the engine leaves out is undone by drift beside it (SC-1637)', () => {
    const rows = rowsOf({
      readings: [
        ['2026-05-01T00:00:00Z', '100'],
        ['2026-05-03T00:00:00Z', '100'],
      ],
      excluded: [['2026-05-02T00:00:00Z', '20']],
    });
    expect(shape(rows)).toEqual([
      [DRIFT_IN_KIND, '100', '2026-05-01T00:00:00.000Z'],
      [DRIFT_OUT_KIND, '-20', '2026-05-02T00:00:00.000Z'],
    ]);
  });
});

/**
 * The property SC-1637 restores: what the money side reads (ledger plus drift)
 * is the engine's balance at every instant from `startsAt`, so flows and the
 * value series never disagree inside a gap.
 */
describe('ledger plus drift equals balanceAt at every instant (SC-1637)', () => {
  const cases: Record<string, Case> = {
    'a feed gap with a ledger row inside it': {
      readings: [
        ['2026-05-01T12:00:00Z', '100'],
        ['2026-05-05T12:00:00Z', '160'],
      ],
      ledger: [['2026-05-02T09:00:00Z', '25']],
    },
    'a feed holding whose ledger starts before its first reading': {
      readings: [
        ['2026-05-03T12:00:00Z', '40'],
        ['2026-05-06T00:00:00Z', '10'],
      ],
      ledger: [
        ['2026-05-01T08:00:00Z', '30'],
        ['2026-05-04T08:00:00Z', '-5'],
      ],
    },
    'a snapshot holding with entries before its first snapshot': {
      kind: 'snapshot',
      readings: [
        ['2026-05-03T12:00:00Z', '50'],
        ['2026-05-06T12:00:00Z', '65'],
      ],
      ledger: [
        ['2026-05-01T10:00:00Z', '10'],
        ['2026-05-02T10:00:00Z', '-4'],
        ['2026-05-04T10:00:00Z', '7'],
      ],
    },
    'a snapshot holding created before its token has a price (SC-1638)': {
      kind: 'snapshot',
      createdAt: '2026-04-20T00:00:00Z',
      pricedFrom: '2026-04-28T00:00:00Z',
      readings: [
        ['2026-05-03T12:00:00Z', '50'],
        ['2026-05-06T12:00:00Z', '65'],
      ],
      ledger: [
        ['2026-04-25T10:00:00Z', '10'],
        ['2026-05-04T10:00:00Z', '7'],
      ],
    },
    'an anchored reading, a verification and an excluded ledger row': {
      readings: [
        ['2026-05-01T00:00:00Z', '100'],
        ['2026-05-04T00:00:00Z', '90'],
      ],
      verifications: [['2026-05-02T00:00:00Z', '150']],
      ledger: [['2026-05-03T00:00:00Z', '-15']],
      excluded: [['2026-05-02T12:00:00Z', '20']],
    },
  };

  for (const [name, c] of Object.entries(cases)) {
    test(name, () => {
      const { ev, ledger, gaps } = build(c);
      const money = [
        ...ledger,
        ...driftRows({ holdingId: 'h', tokenId: 'USD' }, ev, ledger, gaps, pricedFromOf(c)),
      ];
      // Before the first price nothing values the holding on either side (SC-1638).
      const start = Math.max(ev.startsAt.getTime(), pricedFromOf(c)?.getTime() ?? 0);
      const marks = [
        ...ev.observations.map((o) => o.at.getTime()),
        ...ledger.map((r) => r.occurredAt.getTime()),
      ];
      const instants = new Set<number>();
      for (const t of marks) for (const d of [-1, 0, 1]) instants.add(t + d);
      for (let t = start; t < start + 8 * 86_400_000; t += 3_600_000) instants.add(t);
      const disagree: string[] = [];
      for (const t of [...instants].sort((a, b) => a - b)) {
        if (t < start) continue;
        const value = balanceAt(ev, new Date(t));
        const engine =
          value.status === 'absent' ? new Decimal(0) : new Decimal(value.balance.toString());
        const read = money
          .filter((r) => r.occurredAt.getTime() <= t)
          .reduce((s, r) => s.add(r.quantity), new Decimal(0));
        if (!engine.eq(read)) disagree.push(`${new Date(t).toISOString()} ${engine} ≠ ${read}`);
      }
      expect(disagree).toEqual([]);
    });
  }
});

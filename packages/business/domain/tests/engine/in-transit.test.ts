import { describe, expect, test } from 'bun:test';
import { balanceAt } from '../../src/engine/balance-at';
import { inTransitAt, type Transit } from '../../src/engine/in-transit';
import type { HoldingEvidence } from '../../src/engine/types';
import { checkpoint, entry, evidence, utc } from './fixtures';

/**
 * Money answered `internal` to a provider-fed holding counts while it travels
 * (SC-1675). The destination held 1000 before; 500 left the source at SENT.
 * At every instant, the destination's balance plus what is in transit must be
 * 1500: no dip while it travels, and no double count once it lands.
 */

const SENT = utc('2026-01-15', '10:00');
const SENT_TOTAL = '1500';

function destination(fields: Partial<HoldingEvidence>): HoldingEvidence {
  return evidence({ kind: 'feed', ...fields });
}

function total(dest: HoldingEvidence, transit: Transit, at: Date): string {
  const balance = balanceAt(dest, at);
  const held = balance.status === 'absent' ? '0' : balance.balance.toFixed();
  return inTransitAt(dest, transit, at).plus(held).toFixed();
}

const OPENING = checkpoint('c0', utc('2026-01-10'), '1000');

describe('inTransitAt: the arrival is still the person leg', () => {
  const leg = entry('leg', SENT, '500', { kind: 'transfer_in' });
  const transit: Transit = { sent: '500', sentAt: SENT, arrivalId: 'leg', arrived: false };

  test('nothing is in transit before the outflow', () => {
    const dest = destination({ observations: [OPENING], entries: [leg] });
    expect(inTransitAt(dest, transit, utc('2026-01-14')).toFixed()).toBe('0');
  });

  test('answered with no provider reading since: the balance holds it, so 0 is in transit', () => {
    const dest = destination({ observations: [OPENING], entries: [leg] });
    const at = utc('2026-01-15', '12:00');
    expect(inTransitAt(dest, transit, at).toFixed()).toBe('0');
    expect(total(dest, transit, at)).toBe(SENT_TOTAL);
  });

  test('a provider reading that does not hold it yet: all 500 are in transit', () => {
    const dest = destination({
      observations: [OPENING, checkpoint('c1', utc('2026-01-16'), '1000')],
      entries: [leg],
    });
    const at = utc('2026-01-16', '12:00');
    expect(inTransitAt(dest, transit, at).toFixed()).toBe('500');
    expect(total(dest, transit, at)).toBe(SENT_TOTAL);
    expect(total(dest, transit, utc('2026-01-15', '12:00'))).toBe(SENT_TOTAL);
  });

  test('a missing arrival entry is a caller error, not money', () => {
    const dest = destination({ observations: [OPENING], entries: [] });
    expect(() => inTransitAt(dest, transit, utc('2026-01-16'))).toThrow(/leg/);
  });
});

describe('inTransitAt: the provider row holds the arrival', () => {
  const ARRIVED_AT = utc('2026-01-18', '09:00');
  const arrival = entry('arr', ARRIVED_AT, '500', { kind: 'transfer_in', inputId: 'in-1' });
  const transit: Transit = { sent: '500', sentAt: SENT, arrivalId: 'arr', arrived: true };
  const dest = destination({
    observations: [
      OPENING,
      checkpoint('c1', utc('2026-01-16'), '1000'),
      checkpoint('c2', utc('2026-01-19'), '1500'),
    ],
    entries: [arrival],
  });

  test('in history it travels from the outflow until the arrival', () => {
    for (const at of [utc('2026-01-15', '12:00'), utc('2026-01-17')]) {
      expect(inTransitAt(dest, transit, at).toFixed()).toBe('500');
      expect(total(dest, transit, at)).toBe(SENT_TOTAL);
    }
  });

  test('from the arrival on, 0 is in transit, including after a reading that holds it', () => {
    for (const at of [utc('2026-01-18', '12:00'), utc('2026-01-20')]) {
      expect(inTransitAt(dest, transit, at).toFixed()).toBe('0');
      expect(total(dest, transit, at)).toBe(SENT_TOTAL);
    }
  });

  test('a fee-reduced arrival still travels as what was sent', () => {
    const net = entry('arr', ARRIVED_AT, '495', { kind: 'transfer_in', inputId: 'in-1' });
    const withFee = destination({ observations: [OPENING], entries: [net] });
    expect(inTransitAt(withFee, transit, utc('2026-01-17')).toFixed()).toBe('500');
    expect(inTransitAt(withFee, transit, utc('2026-01-18', '12:00')).toFixed()).toBe('0');
  });
});

import { describe, expect, test } from 'bun:test';
import { renderWeeklyDigestEmail, type WeeklyDigestContent } from '../../src/templates';
import { SCANI_BRAND } from '../../src/types';

const UNSUB = 'https://api.scani.xyz/e/u/8b1f1a2e-0000-4000-8000-000000000000';

const digest = (over: Partial<WeeklyDigestContent> = {}): WeeklyDigestContent => ({
  netWorth: '$120,400.00',
  asOf: '2026-08-18',
  change: { amount: '+$2,510.00', percent: '+2.1%', direction: 'up' },
  movers: [{ symbol: 'BTC', amount: '+$1,900.00', percent: '+3.4%', direction: 'up' }],
  bills: [{ vendorName: 'Rent', dueDate: '2026-08-25', amount: '€1,200.00' }],
  moreBills: 0,
  reviewCount: 2,
  ...over,
});

const render = (over: Partial<WeeklyDigestContent> = {}) =>
  renderWeeklyDigestEmail({
    brand: SCANI_BRAND,
    name: 'Alice Example',
    digest: digest(over),
    unsubscribeUrl: UNSUB,
    appUrl: 'https://app.scani.xyz',
  });

describe('renderWeeklyDigestEmail', () => {
  test('the unsubscribe link is in both bodies', () => {
    // SC-460's second guardrail. An unsubscribe that only exists in the HTML
    // is missing from every plain-text client, and a reader who cannot find
    // one reports the mail as spam instead.
    const out = render();
    expect(out.html).toContain(UNSUB);
    expect(out.text).toContain(UNSUB);
  });

  test('the unsubscribe link is a plain anchor, not a form or a button', () => {
    // One click, no sign-in. A GET link is what a mail client can follow.
    expect(render().html).toContain(`<a href="${UNSUB}"`);
    expect(render().html).not.toContain('<form');
  });

  test('the headline figure and its date both appear', () => {
    const out = render();
    expect(out.html).toContain('$120,400.00');
    // The date is load-bearing: the figure is the rollup's, not "now".
    expect(out.html).toContain('2026-08-18');
    expect(out.text).toContain('as of 2026-08-18');
  });

  test('the subject carries the number, so the inbox line is a reason to open', () => {
    expect(render().subject).toBe('Scani: $120,400.00 (+2.1% this week)');
  });

  test('a week with no comparable figure still renders, without inventing one', () => {
    const out = render({ change: null });
    expect(out.subject).toBe('Scani: $120,400.00');
    expect(out.html).toContain('No comparable figure from last week yet.');
  });

  test('empty sections are omitted entirely rather than rendered as headings', () => {
    const out = render({ movers: [], bills: [], moreBills: 0, reviewCount: 0 });
    expect(out.html).not.toContain('Biggest movers');
    expect(out.html).not.toContain('Due in the next 7 days');
    expect(out.html).not.toContain('review queue');
  });

  test('bills beyond the listed ones are counted, not dropped', () => {
    const out = render({ moreBills: 4 });
    expect(out.html).toContain('and 4 more');
    expect(out.text).toContain('and 4 more');
  });

  test('a bill with no estimate says so instead of claiming zero', () => {
    const out = render({ bills: [{ vendorName: 'Water', dueDate: '2026-08-22', amount: null }] });
    expect(out.text).toContain('amount not set');
    expect(out.text).not.toContain('Water — 0');
  });

  test('a vendor name cannot open a tag', () => {
    const out = render({
      bills: [{ vendorName: '<script>alert(1)</script>', dueDate: '2026-08-22', amount: null }],
    });
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
  });

  test('addresses the reader by first name only', () => {
    expect(render().text.startsWith('Hi Alice,')).toBe(true);
  });
});

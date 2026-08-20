import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemberList } from '@/v3/components/membership/MemberList';
import type { MemberEntry } from '@/v3/lib/membership';

/**
 * SC-388 — the group page rendered three counts and no two of them agreed.
 * These pin the two properties that fix has to keep: a count belongs to one
 * kind of thing, and a row the total does not count says so where the reader
 * meets it.
 */

function holding(id: string, label: string, inactive = false): MemberEntry {
  return { id, kind: 'holding', label, sublabel: `${label} · Kraken`, inactive };
}

function account(id: string, label: string): MemberEntry {
  return { id, kind: 'account', label, sublabel: 'All 12 holdings' };
}

function render(members: MemberEntry[]): string {
  return renderToStaticMarkup(
    <MemberList
      members={members}
      pendingIds={new Set()}
      onRemove={() => {}}
      removeLabel={(entry) => `Remove ${entry.label}`}
    />
  );
}

describe('MemberList', () => {
  test('each run counts itself, and nothing prints their sum', () => {
    const markup = render([holding('h1', 'BTC'), holding('h2', 'ETH'), account('a1', 'Kraken')]);
    expect(markup).toContain('Holdings (2)');
    expect(markup).toContain('Whole accounts (1)');
    // 3 is what `members.length` was; on production it was 46 above a list of
    // 36. A count of members is in a unit no other figure on the page uses.
    expect(markup).not.toContain('(3)');
  });

  test('an empty run prints no title rather than a zero', () => {
    const markup = render([holding('h1', 'BTC')]);
    expect(markup).toContain('Holdings (1)');
    expect(markup).not.toContain('Whole accounts');
  });

  /** The figure above says how many holdings it leaves out; this is the only
   *  thing on the screen that says WHICH. */
  test('the row the total does not count carries the same badge the holdings list uses', () => {
    const markup = render([holding('h1', 'BTC'), holding('h2', 'ETH', true)]);
    expect(markup).toContain('Inactive');
    expect(markup.indexOf('ETH')).toBeLessThan(markup.indexOf('Inactive'));
  });

  test('an ordinary group has no badge at all', () => {
    expect(render([holding('h1', 'BTC')])).not.toContain('Inactive');
  });
});

import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { Users } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
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
    <StaticRouter location="/">
      <MemberList
        basePath="/groups/g1"
        members={members}
        pendingIds={new Set()}
        onRemove={() => {}}
        removeLabel={(entry) => `Remove ${entry.label}`}
        empty={{
          icon: Users,
          titleKey: 'ui.dataView.groupMembers.empty.title',
          action: <button type="button">Add to group</button>,
        }}
      />
    </StaticRouter>
  );
}

describe('MemberList', () => {
  // SC-1419, rule 5: a member row showed a badge and no figure, so a group's
  // rows could not be compared by what they are worth.
  test('a row shows its figure, with the badge under it', () => {
    const markup = render([
      {
        ...holding('h1', 'BTC'),
        membership: 'direct',
        figure: { value: 48250.5, currency: '€' },
      },
    ]);
    expect(markup).toContain('48,250.50');
    expect(markup.indexOf('48,250.50')).toBeLessThan(markup.indexOf('Direct'));
  });

  // SC-1419, rule 8: the list's own empty state was the Holdings one with no
  // action; it is now the page's, add action included.
  test('an empty list shows the page empty state and its action', () => {
    const markup = render([]);
    expect(markup).toContain('Nothing in this group yet');
    expect(markup).toContain('Add to group');
    expect(markup).not.toContain('No holdings');
  });

  // SC-1404. The per-kind count lives once, in the header's `memberCountLine`
  // (SC-388's rule is pinned there); the list repeating it was a second,
  // unstyled line that read as a heading.
  test('the list prints no count line of its own', () => {
    const markup = render([holding('h1', 'BTC'), holding('h2', 'ETH'), account('a1', 'Kraken')]);
    expect(markup).not.toContain('Holdings (2)');
    expect(markup).not.toContain('Whole accounts (1)');
  });

  // SC-1404. Rows carry no action, as on Accounts, Holdings and Bills: a row
  // opens its peek, and Remove is the peek's action.
  test('a row carries no Remove button', () => {
    const markup = render([holding('h1', 'BTC'), account('a1', 'Kraken')]);
    expect(markup).toContain('BTC');
    expect(markup).not.toContain('Remove BTC');
    expect(markup).not.toContain('>Remove<');
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

describe('bills in a group (SC-1408)', () => {
  test('a bill in by its payee says so, the way a holding in by its account does', () => {
    const markup = render([
      {
        id: 'b1',
        kind: 'bill',
        label: 'Rent',
        sublabel: 'Monthly · Outgoing',
        membership: 'payee',
      },
      {
        id: 'b2',
        kind: 'bill',
        label: 'Gym',
        sublabel: 'Monthly · Outgoing',
        membership: 'direct',
      },
    ]);
    expect(markup).toContain('From payee rule');
    expect(markup).toContain('Direct member');
  });
});

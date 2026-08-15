import { describe, expect, test } from 'bun:test';
import {
  canArmPullToRefresh,
  NESTED_SCROLL_SELECTOR,
  type PullGestureNode,
} from '../../src/lib/pull-to-refresh';

/**
 * The nesting this rule exists for, built as a tree rather than asserted one
 * selector at a time — the bug it fixes was never about a single element, it
 * was about what sits between the finger and the page.
 *
 * `matches` here is a substring test against the node's declared class and
 * attribute list, which is all `canArmPullToRefresh` asks of a real
 * `Element`. There is no DOM in `bun test`.
 */
interface FakeSpec {
  /** Selectors this node would answer `true` to, e.g. `.overflow-y-auto`. */
  is?: string[];
  children?: Record<string, FakeSpec>;
}

class FakeNode implements PullGestureNode {
  parentElement: FakeNode | null = null;
  constructor(readonly selectors: string[]) {}
  matches(selectors: string): boolean {
    const wanted = selectors.split(',');
    return this.selectors.some((own) => wanted.includes(own));
  }
}

/** Builds the tree and returns every node by name. */
function tree(spec: FakeSpec, name = 'root', into: Record<string, FakeNode> = {}) {
  const node = new FakeNode(spec.is ?? []);
  into[name] = node;
  for (const [childName, childSpec] of Object.entries(spec.children ?? {})) {
    tree(childSpec, childName, into);
    into[childName].parentElement = node;
  }
  return into;
}

/** The v3 shell, near enough: one page scroller with the surfaces v3 stacks. */
const shell = tree({
  is: ['.overflow-y-auto'],
  children: {
    row: { children: { rowLabel: {} } },
    allocationBar: { is: ['.overflow-x-auto'], children: { segment: {} } },
    scrollArea: { is: ['[data-radix-scroll-area-viewport]'], children: { scrollAreaRow: {} } },
    table: { is: ['table'], children: { cell: {} } },
    chart: { is: ['[data-no-pull-to-refresh]'], children: { chartPoint: {} } },
  },
});
const scroller = shell.root;

/** The chrome, which lives beside the scroller rather than inside it. */
const chrome = tree({
  children: {
    sheet: { is: ['[role="dialog"]'], children: { sheetBody: { is: ['.overflow-y-auto'] } } },
    tabBar: { children: { tabBarButton: {} } },
  },
});

describe('canArmPullToRefresh', () => {
  test('arms on the page scroller’s own content', () => {
    expect(canArmPullToRefresh(shell.rowLabel, scroller)).toEqual({ armed: true });
  });

  test('arms when the touch is the scroller itself', () => {
    expect(canArmPullToRefresh(scroller, scroller)).toEqual({ armed: true });
  });

  test('refuses a touch with no target', () => {
    expect(canArmPullToRefresh(null, scroller)).toEqual({ armed: false, reason: 'no-target' });
  });

  test('refuses inside a horizontally scrollable region', () => {
    expect(canArmPullToRefresh(shell.segment, scroller)).toEqual({
      armed: false,
      reason: 'nested-scroll',
    });
  });

  test('refuses inside a ScrollArea viewport', () => {
    expect(canArmPullToRefresh(shell.scrollAreaRow, scroller)).toEqual({
      armed: false,
      reason: 'nested-scroll',
    });
  });

  test('refuses inside a table', () => {
    expect(canArmPullToRefresh(shell.cell, scroller)).toEqual({
      armed: false,
      reason: 'nested-scroll',
    });
  });

  test('refuses anything that opted out', () => {
    expect(canArmPullToRefresh(shell.chartPoint, scroller)).toEqual({
      armed: false,
      reason: 'nested-scroll',
    });
  });

  test('refuses a sheet, drawer or dialog even when it is nested inside', () => {
    // The peek sheet portalled *into* the scroller — the configuration V3-22
    // made possible and the one the old `scrollTop <= 1` rule refreshed under.
    const nestedSheet = new FakeNode(['[role="dialog"]']);
    nestedSheet.parentElement = scroller;
    const inside = new FakeNode([]);
    inside.parentElement = nestedSheet;
    expect(canArmPullToRefresh(inside, scroller)).toEqual({
      armed: false,
      reason: 'nested-scroll',
    });
  });

  test('refuses a portalled overlay, which is not under the scroller at all', () => {
    expect(canArmPullToRefresh(chrome.sheetBody, scroller).armed).toBe(false);
  });

  test('refuses chrome outside the scroller even with nothing scrollable in it', () => {
    // The tab bar is `fixed`, so it is a sibling of the page scroller and
    // matches none of the selectors. Ancestry, not selectors, has to catch it.
    expect(canArmPullToRefresh(chrome.tabBarButton, scroller)).toEqual({
      armed: false,
      reason: 'outside-scroller',
    });
  });

  test('does not judge the scroller by its own overflow class', () => {
    // The scroller in both shells is `.overflow-y-auto`. If the walk included
    // it, pull-to-refresh could never arm anywhere.
    expect(scroller.matches(NESTED_SCROLL_SELECTOR)).toBe(true);
    expect(canArmPullToRefresh(shell.row, scroller).armed).toBe(true);
  });
});

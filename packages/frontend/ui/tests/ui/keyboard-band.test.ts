import { describe, expect, test } from 'bun:test';
import { keyboardBand } from '../../src/ui/bottom-drawer';

/**
 * SC-1434: with the iOS keyboard up the drawer stands on it. Figures measured
 * on an iPhone 17 simulator in Safari: layout 714, visual 404 with the keyboard
 * up, 714 with it down.
 */
describe('keyboardBand', () => {
  test('the keyboard: the drawer bottom sits on its top edge, height is the visible band', () => {
    expect(keyboardBand(714, 0, 404)).toEqual({ bottom: 310, height: 404 });
  });

  test('a scrolled visual viewport still lands on the keyboard edge', () => {
    expect(keyboardBand(714, 60, 404)).toEqual({ bottom: 250, height: 404 });
  });

  test('no keyboard, and browser chrome settling, leave the drawer alone', () => {
    expect(keyboardBand(714, 0, 714)).toBeNull();
    expect(keyboardBand(714, 0, 660)).toBeNull();
  });
});

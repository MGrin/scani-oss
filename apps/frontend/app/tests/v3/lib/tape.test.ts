import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { composeTape, rollFrom, type TapeCell, tapeCells } from '../../../src/v3/lib/tape';

describe('composeTape', () => {
  test('splits the hero into the three bands the brief sets separately', () => {
    const parts = composeTape('128432.10', 'USD');
    expect(parts.symbol).toBe('$');
    expect(parts.groups).toEqual(['128', '432']);
    expect(parts.decimal).toBe('.');
    expect(parts.fraction).toBe('10');
    expect(parts.sign).toBe('');
  });

  test('a screen reader hears the ordinary figure, not the decomposition', () => {
    expect(composeTape(128432.1, 'USD').accessibleText).toBe('$128,432.10');
  });

  test('a negative total keeps its sign at display size', () => {
    const parts = composeTape(-1250.5, 'USD');
    expect(parts.sign).toBe('−');
    expect(parts.groups).toEqual(['1', '250']);
    expect(parts.fraction).toBe('50');
  });

  test('a value that rounds to zero is not negative', () => {
    expect(composeTape(-0.004, 'USD').sign).toBe('');
  });

  test('a non-ISO token symbol falls back rather than throwing', () => {
    const parts = composeTape(4200, 'PRIVATECO');
    expect(parts.symbol).toBe('PRIVATECO');
    expect(parts.groups).toEqual(['4', '200']);
  });

  test('an unknown total is a placeholder, not a zero', () => {
    for (const value of [null, undefined, '', 'oops', Number.NaN]) {
      const parts = composeTape(value, 'USD');
      expect(parts.isPlaceholder).toBe(true);
      expect(parts.groups).toEqual(['—']);
    }
  });
});

describe('tapeCells', () => {
  test('groups are separated by the locale separator in a cell of its own', () => {
    // SC-71 6.2: the separator used to be a blank cell, so the hero printed
    // `128 432` while every other surface printed `128,432`. It is a cell of
    // its own — narrower than a digit — but it carries the glyph.
    const cells = tapeCells(composeTape(128432.1, 'USD'));
    expect(cells.filter((cell) => cell.kind === 'group')).toEqual([{ kind: 'group', char: ',' }]);
    expect(cells.map((cell) => cell.char).join('')).toBe('128,432');
  });

  test('a figure with nothing to group has no separator cell', () => {
    expect(tapeCells(composeTape(842, 'USD')).some((cell) => cell.kind === 'group')).toBe(false);
  });

  test('the sign gets a cell and does not roll', () => {
    const [first] = tapeCells(composeTape(-42, 'USD'));
    expect(first).toEqual({ kind: 'glyph', char: '−', rolls: false });
  });

  test('a placeholder has nothing to roll', () => {
    expect(tapeCells(composeTape(null, 'USD'))).toEqual([
      { kind: 'glyph', char: '—', rolls: false },
    ]);
  });
});

const cellsFor = (value: number): TapeCell[] => tapeCells(composeTape(value, 'USD'));

describe('rollFrom', () => {
  test('only the digits that changed roll', () => {
    const from = rollFrom(cellsFor(47382), cellsFor(47391));
    // `47,382` → `47,391`: six cells, one of them the separator.
    expect(from).toEqual([null, null, null, null, '8', '2']);
  });

  test('an unchanged figure rolls nothing', () => {
    expect(rollFrom(cellsFor(47382), cellsFor(47382)).every((entry) => entry === null)).toBe(true);
  });

  test('a longer figure aligns from the right, so its tail does not re-roll', () => {
    // `99 998` → `199 998`. Index-from-the-left would call every cell changed;
    // from the right only the digit that appeared is new, and it has no
    // predecessor to roll from, so nothing moves.
    const from = rollFrom(cellsFor(99998), cellsFor(199998));
    expect(from.every((entry) => entry === null)).toBe(true);
  });

  test('crossing a power of ten rolls every digit that actually differs', () => {
    // `99 998` → `100 002`, right-aligned: `_99998` against `100002`.
    const from = rollFrom(cellsFor(99998), cellsFor(100002));
    expect(from.filter((entry) => entry !== null)).toEqual(['9', '9', '9', '9', '8']);
    // The cell the figure grew has no predecessor, so it appears in place.
    expect(from[0]).toBeNull();
  });

  test('the first render rolls nothing, because nothing changed', () => {
    const cells = cellsFor(128432.1);
    expect(rollFrom(cells, cells).every((entry) => entry === null)).toBe(true);
  });
});

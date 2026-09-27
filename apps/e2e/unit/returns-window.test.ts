import { describe, expect, test } from 'bun:test';
import { pinReturnsWindow } from '../visual/returns-window';

const AS_OF = '2027-03-04';

describe('pinReturnsWindow', () => {
  test('ytd becomes the year to date of the pinned day, keeping the scope', () => {
    const scope = { kind: 'account', id: 'a' };
    expect(pinReturnsWindow({ window: { kind: 'ytd' }, scope }, AS_OF)).toEqual({
      kind: 'pinned',
      input: { window: { kind: 'custom', from: '2027-01-01', to: AS_OF }, scope },
    });
  });

  test('1y becomes the 365 days ending on the pinned day', () => {
    expect(pinReturnsWindow({ window: { kind: '1y' } }, AS_OF)).toEqual({
      kind: 'pinned',
      input: { window: { kind: 'custom', from: '2026-03-04', to: AS_OF } },
    });
  });

  test('a custom window is already the browser clock and passes through', () => {
    const input = { window: { kind: 'custom', from: '2027-02-01', to: AS_OF } };
    expect(pinReturnsWindow(input, AS_OF)).toEqual({ kind: 'unchanged', input });
  });

  test('all, and anything unrecognised, is refused rather than sent unpinned', () => {
    expect(pinReturnsWindow({ window: { kind: 'all' } }, AS_OF).kind).toBe('refused');
    expect(pinReturnsWindow({ window: { kind: '5y' } }, AS_OF).kind).toBe('refused');
    expect(pinReturnsWindow({}, AS_OF).kind).toBe('refused');
  });
});

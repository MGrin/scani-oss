import { describe, expect, test } from 'bun:test';
import { declareWindow } from '../../../../src/services/feeds/blocks/window-declarer';

const at = (iso: string) => new Date(iso);
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const FETCHED = at('2026-07-10T12:00:00Z');

describe('declareWindow: balance-snapshot', () => {
  test('runs from the earliest capture to the fetch and never claims completeness', () => {
    const window = declareWindow({
      shape: 'balance-snapshot',
      capturedAt: [
        at('2026-07-10T11:00:00Z'),
        at('2026-07-10T09:00:00Z'),
        at('2026-07-10T10:00:00Z'),
      ],
      fetchedAt: FETCHED,
    });
    expect(window).toStrictEqual({
      shape: 'balance-snapshot',
      from: at('2026-07-10T09:00:00Z'),
      to: FETCHED,
      complete: false,
    });
  });

  test('a single capture bounds the window at that instant', () => {
    const window = declareWindow({
      shape: 'balance-snapshot',
      capturedAt: [FETCHED],
      fetchedAt: FETCHED,
    });
    expect(window.from).toEqual(FETCHED);
    expect(window.to).toEqual(FETCHED);
  });

  test('refuses a declaration with no capture, since no instant bounds it', () => {
    expect(() =>
      declareWindow({ shape: 'balance-snapshot', capturedAt: [], fetchedAt: FETCHED })
    ).toThrow(RangeError);
  });

  test('does not reorder or modify the dates it is given', () => {
    const capturedAt = [at('2026-07-10T11:00:00Z'), at('2026-07-10T09:00:00Z')];
    declareWindow({ shape: 'balance-snapshot', capturedAt, fetchedAt: FETCHED });
    expect(capturedAt.map((d) => d.toISOString())).toEqual([
      '2026-07-10T11:00:00.000Z',
      '2026-07-10T09:00:00.000Z',
    ]);
  });
});

describe('declareWindow: statement-upload', () => {
  test('spans the earliest to the latest row and carries the upload', () => {
    const window = declareWindow({
      shape: 'statement-upload',
      rowDates: [
        at('2026-06-15T00:00:00Z'),
        at('2026-06-01T00:00:00Z'),
        at('2026-06-30T00:00:00Z'),
      ],
      uploadRef: 'upload-42',
    });
    expect(window).toStrictEqual({
      shape: 'statement-upload',
      from: at('2026-06-01T00:00:00Z'),
      to: at('2026-06-30T00:00:00Z'),
      complete: false,
      uploadRef: 'upload-42',
    });
  });

  test('refuses a declaration with no row, since no instant bounds it', () => {
    expect(() =>
      declareWindow({ shape: 'statement-upload', rowDates: [], uploadRef: 'upload-42' })
    ).toThrow(RangeError);
  });
});

describe('declareWindow: transaction-run', () => {
  test('a complete run with no bound has an open start and ends at the fetch', () => {
    const window = declareWindow({
      shape: 'transaction-run',
      fetchedAt: FETCHED,
      retracted: false,
    });
    expect(window).toStrictEqual({
      shape: 'transaction-run',
      from: null,
      to: FETCHED,
      complete: true,
    });
  });

  test('`until` replaces the fetch as the end', () => {
    const until = at('2026-07-09T00:00:00Z');
    const window = declareWindow({
      shape: 'transaction-run',
      fetchedAt: FETCHED,
      until,
      retracted: false,
    });
    expect(window.to).toEqual(until);
  });

  test('`since` bounds the start and wins over every other source', () => {
    const since = at('2026-07-01T00:00:00Z');
    const window = declareWindow({
      shape: 'transaction-run',
      fetchedAt: FETCHED,
      since,
      historyStartsAt: at('2026-01-01T00:00:00Z'),
      firstEventAt: at('2026-02-01T00:00:00Z'),
      retracted: false,
    });
    expect(window).toStrictEqual({
      shape: 'transaction-run',
      from: since,
      to: FETCHED,
      complete: true,
    });
  });

  test("the provider's `historyStartsAt` bounds a run that has no `since`", () => {
    const historyStartsAt = at('2025-03-01T00:00:00Z');
    const window = declareWindow({
      shape: 'transaction-run',
      fetchedAt: FETCHED,
      historyStartsAt,
      retracted: false,
    });
    expect(window).toStrictEqual({
      shape: 'transaction-run',
      from: historyStartsAt,
      to: FETCHED,
      complete: true,
    });
  });

  test('a retracted since-run is incomplete and bounded by since', () => {
    const since = at('2026-07-01T00:00:00Z');
    const window = declareWindow({
      shape: 'transaction-run',
      fetchedAt: FETCHED,
      since,
      retracted: true,
    });
    expect(window).toStrictEqual({
      shape: 'transaction-run',
      from: since,
      to: FETCHED,
      complete: false,
    });
  });

  test('a Gemini-style horizon is incomplete even with no since', () => {
    const window = declareWindow({
      shape: 'transaction-run',
      fetchedAt: FETCHED,
      horizonMs: 30 * DAY_MS,
      retracted: false,
    });
    expect(window).toStrictEqual({
      shape: 'transaction-run',
      from: new Date(FETCHED.getTime() - 30 * DAY_MS),
      to: FETCHED,
      complete: false,
    });
  });

  test('a horizon of zero is still a horizon', () => {
    const window = declareWindow({
      shape: 'transaction-run',
      fetchedAt: FETCHED,
      horizonMs: 0,
      retracted: false,
    });
    expect(window).toStrictEqual({
      shape: 'transaction-run',
      from: FETCHED,
      to: FETCHED,
      complete: false,
    });
  });

  test('a retracted run with no `since` starts at the first event it saw', () => {
    const firstEventAt = at('2026-06-20T08:00:00Z');
    const window = declareWindow({
      shape: 'transaction-run',
      fetchedAt: FETCHED,
      firstEventAt,
      retracted: true,
    });
    expect(window).toStrictEqual({
      shape: 'transaction-run',
      from: firstEventAt,
      to: FETCHED,
      complete: false,
    });
  });

  test('a retracted run with nothing to bound it starts at the fetch, never open', () => {
    const window = declareWindow({ shape: 'transaction-run', fetchedAt: FETCHED, retracted: true });
    expect(window).toStrictEqual({
      shape: 'transaction-run',
      from: FETCHED,
      to: FETCHED,
      complete: false,
    });
  });

  test('a horizon outranks the first event, and `historyStartsAt` outranks the horizon', () => {
    const horizon = declareWindow({
      shape: 'transaction-run',
      fetchedAt: FETCHED,
      horizonMs: DAY_MS,
      firstEventAt: at('2026-07-10T01:00:00Z'),
      retracted: false,
    });
    expect(horizon.from).toEqual(new Date(FETCHED.getTime() - DAY_MS));

    const history = declareWindow({
      shape: 'transaction-run',
      fetchedAt: FETCHED,
      horizonMs: DAY_MS,
      historyStartsAt: at('2026-07-05T00:00:00Z'),
      retracted: false,
    });
    expect(history.from).toEqual(at('2026-07-05T00:00:00Z'));
    expect(history.complete).toBe(false);
  });

  test('declares the same window for the same input, with no clock behind it', () => {
    const declaration = {
      shape: 'transaction-run',
      fetchedAt: FETCHED,
      horizonMs: HOUR_MS,
      retracted: false,
    } as const;
    expect(declareWindow(declaration)).toStrictEqual(declareWindow(declaration));
  });
});

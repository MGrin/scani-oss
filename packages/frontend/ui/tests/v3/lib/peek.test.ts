import { describe, expect, test } from 'bun:test';
import {
  PEEK_STATE_KEY,
  parsePeekId,
  peekOpenState,
  peekPath,
  resolvePeekClose,
} from '@scani/ui/v3/lib/peek';

describe('parsePeekId', () => {
  test('reads the record id one segment below the surface', () => {
    expect(parsePeekId('/holdings/h1', '/holdings')).toBe('h1');
  });

  test('the list itself is not a peek', () => {
    expect(parsePeekId('/holdings', '/holdings')).toBeNull();
    expect(parsePeekId('/holdings/', '/holdings')).toBeNull();
  });

  // The one that would silently open the wrong sheet over the wrong screen.
  test('a deeper route is not a peek at its first segment', () => {
    expect(parsePeekId('/payments/recurring/r1', '/payments')).toBeNull();
  });

  test('a sibling path that merely shares a prefix is not a peek', () => {
    expect(parsePeekId('/holdings-archive/h1', '/holdings')).toBeNull();
  });

  test('round-trips an id that needs escaping', () => {
    const id = 'wallet/0x7f 2c';
    expect(parsePeekId(peekPath('/holdings', id), '/holdings')).toBe(id);
  });

  test('a malformed escape is not an id', () => {
    expect(parsePeekId('/holdings/%E0%A4%A', '/holdings')).toBeNull();
  });

  test('a base path written with a trailing slash still resolves', () => {
    expect(parsePeekId('/holdings/h1', '/holdings/')).toBe('h1');
  });
});

describe('peekPath', () => {
  test('carries the list’s query string onto the record', () => {
    // V3-40: the tab bar lights Accounts on holdings narrowed to one account,
    // and dropping the filter here would darken it the moment the reader opens
    // a row. It also makes the peek's URL shareable as what it actually is —
    // one holding inside one account's list.
    expect(peekPath('/holdings', 'h1', '?account=acc1')).toBe('/holdings/h1?account=acc1');
  });

  test('adds no bare question mark when the list is unfiltered', () => {
    expect(peekPath('/holdings', 'h1')).toBe('/holdings/h1');
    expect(peekPath('/holdings', 'h1', '')).toBe('/holdings/h1');
    expect(peekPath('/holdings', 'h1', '?')).toBe('/holdings/h1');
  });

  test('a query string handed over without its leading ? still works', () => {
    expect(peekPath('/holdings', 'h1', 'account=acc1')).toBe('/holdings/h1?account=acc1');
  });
});

describe('resolvePeekClose', () => {
  test('pops the entry we pushed, so closing and the back gesture agree', () => {
    expect(resolvePeekClose('/holdings', peekOpenState('/holdings'))).toEqual({
      type: 'back',
    });
  });

  test('a deep link has nothing of ours to pop, so it lands on the list', () => {
    expect(resolvePeekClose('/holdings', null)).toEqual({
      type: 'replace',
      to: '/holdings',
    });
  });

  // A `state` object survives a client-side navigation between surfaces. If the
  // key were a bare boolean, a peek opened on holdings would convince the
  // payments peek that its own entry is poppable, and closing it would go back
  // to holdings instead.
  test('another surface’s open state does not make this one poppable', () => {
    expect(resolvePeekClose('/payments', { [PEEK_STATE_KEY]: '/holdings' })).toEqual({
      type: 'replace',
      to: '/payments',
    });
  });

  test('a trailing slash on the base path does not strand the sheet', () => {
    expect(resolvePeekClose('/holdings/', peekOpenState('/holdings'))).toEqual({
      type: 'back',
    });
  });
});

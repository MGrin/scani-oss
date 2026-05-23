import { describe, expect, test } from 'bun:test';
import { cn } from '../../src/lib/cn';

describe('cn', () => {
  test('joins string class names with spaces', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  test('drops falsy values (undefined / null / false / empty)', () => {
    expect(cn('foo', undefined, null, false, '', 'bar')).toBe('foo bar');
  });

  test('flattens arrays + objects via clsx', () => {
    expect(cn(['foo', 'bar'], { baz: true, qux: false })).toBe('foo bar baz');
  });

  test('tailwind-merge: later utility class wins for conflicting families', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
  });

  test('non-conflicting tailwind classes stay side-by-side', () => {
    expect(cn('flex', 'items-center', 'gap-2')).toBe('flex items-center gap-2');
  });

  test('conditional patterns: variant + override', () => {
    const isActive = true;
    expect(cn('px-4 py-2', isActive && 'bg-primary')).toBe('px-4 py-2 bg-primary');
  });
});

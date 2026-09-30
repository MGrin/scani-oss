import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const SOURCE = await Bun.file(
  join(import.meta.dir, '../../../src/v3/components/PageLayout.tsx')
).text();

/** The cap a measure applies below `lg`: its first, unprefixed `max-w-[…]`. */
function belowLg(measure: string): string | null {
  const line = new RegExp(`^\\s*${measure}: '([^']*)'`, 'm').exec(SOURCE)?.[1] ?? '';
  return /(?:^|\s)(max-w-\[\d+px\])/.exec(line)?.[1] ?? null;
}

describe('page measures below 1024px (UI standard rule 10, SC-1433)', () => {
  test('the dashboard takes the list pages’ cap, so Home is as wide as Accounts at 820', () => {
    expect(belowLg('wide')).not.toBeNull();
    expect(belowLg('grid')).toBe(belowLg('wide'));
  });

  test('forms keep their reading column', () => {
    expect(belowLg('narrow')).toBe('max-w-[560px]');
  });
});

describe('dashboard spans on a narrow desktop (SC-1433)', () => {
  test('a third is a half until xl, so three cards never share 1024-1279', () => {
    expect(SOURCE).toContain("third: 'lg:col-span-6 xl:col-span-4'");
  });
});

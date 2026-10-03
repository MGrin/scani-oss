import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '../../src');

function boundaryTags(source: string): string[] {
  return [...source.matchAll(/<(?:Chunk)?ErrorBoundary\b[^>]*>/gs)].map((m) => m[0]);
}

describe('every error boundary in the app reports what it caught (SC-1492)', () => {
  const files = [...new Bun.Glob('**/*.tsx').scanSync(SRC)];

  test('the scan sees the root boundary', () => {
    expect(boundaryTags(readFileSync(join(SRC, 'main.tsx'), 'utf8')).length).toBeGreaterThan(0);
  });

  test('no boundary is mounted without onError', () => {
    const silent = files.flatMap((file) =>
      boundaryTags(readFileSync(join(SRC, file), 'utf8'))
        .filter((tag) => !tag.includes('onError'))
        .map((tag) => `${file}: ${tag.replace(/\s+/g, ' ')}`)
    );
    expect(silent).toEqual([]);
  });
});

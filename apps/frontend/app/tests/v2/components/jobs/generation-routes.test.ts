import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * No shared job-result renderer may navigate to a raw `V2_ROUTES` path.
 *
 * These components are not v2's. `resolveV3ReviewRenderer` delegates every job
 * kind but one straight to `v2/lib/review-registry`, so the same component
 * renders inside the v3 shell — and its onward navigation was written against
 * `V2_ROUTES`, which is absolute to `/v2` by construction. A v3 reader who
 * pressed "Import 3 holdings" was therefore ejected into the classic UI by the
 * confirmation of their own success (SC-134): the sidebar's first item changed,
 * a "Sign out" appeared, and at phone width three of five tab-bar labels
 * swapped under their thumb.
 *
 * Nothing else in the toolchain can see this. The types are identical either
 * way — `V2_ROUTES.holdings` is a `string` and so is the generation-aware
 * rewrite of it — and no unit test of these components asserts which shell they
 * happen to be mounted in. So the check is a source scan, the same instrument
 * and for the same reason as `tests/v3/lib/query-producers.test.ts`.
 *
 * `JobHeader` is excluded because it is not a renderer: v3's `JobDetailPage`
 * draws its own `JobDetailHeader` and never mounts this one.
 */

const JOBS_DIR = join(import.meta.dir, '../../../../src/v2/components/jobs');

/**
 * Comments are stripped first. Every file here explains itself in prose and
 * several of those paragraphs now name `V2_ROUTES` while describing this very
 * defect — a scan that read comments would fail on its own documentation.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every component the registry can hand v3, by file. */
const SHARED_RENDERERS = [
  'DocumentParseResult.tsx',
  'ExchangeImportResult.tsx',
  'FileImportResult.tsx',
  'ManualHoldingsCreateResult.tsx',
  'ReviewHoldingsCard.tsx',
  'ScreenshotParseResult.tsx',
  'WalletImportResult.tsx',
];

/**
 * A `V2_ROUTES` reference that is NOT already inside a `toGeneration(...)` /
 * `navigateInGeneration(...)` call. Matching the wrapper by name rather than
 * parsing is enough: the wrapper always immediately precedes the reference on
 * the same expression, and a renamed import would fail the type check.
 */
function unwrappedRouteUses(source: string): string[] {
  const lines = source.split('\n');
  const found: string[] = [];
  let pending = '';
  for (const line of lines) {
    if (!line.includes('V2_ROUTES')) {
      pending = line;
      continue;
    }
    if (line.trimStart().startsWith('import ')) continue;
    const context = `${pending}\n${line}`;
    if (/toGeneration\(|navigateInGeneration\(/.test(context)) continue;
    found.push(line.trim());
  }
  return found;
}

describe('shared job renderers navigate within the current UI generation', () => {
  test.each(SHARED_RENDERERS)('%s routes through the generation-aware helper', (file) => {
    const source = stripComments(readFileSync(join(JOBS_DIR, file), 'utf8'));
    expect(unwrappedRouteUses(source)).toEqual([]);
  });

  // The scan is only worth having if it can fail — a typo in the directory
  // path would make every case above pass on an empty string.
  test('the scan is reading real files', () => {
    const source = readFileSync(join(JOBS_DIR, 'ReviewHoldingsCard.tsx'), 'utf8');
    expect(source).toContain('V2_ROUTES');
    expect(unwrappedRouteUses(`  navigate(V2_ROUTES.holdings);`)).toHaveLength(1);
  });
});

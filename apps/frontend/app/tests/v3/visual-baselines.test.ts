import '../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The visual-regression gate (SC-24) renders inside the Playwright container,
 * so nothing about it can run in `bun run test` — and a gate that needs Docker
 * to say anything at all is a gate that goes unrun on the machine that most
 * needs it. These are the assertions that hold without one.
 *
 * What they protect is the pairing. A baseline is a committed PNG and a screen
 * is a line in `visual/screens.ts`, and the two are joined by a filename:
 *
 * - rename a screen and its PNG is orphaned — still in the repo, reviewed by
 *   nobody, asserting nothing,
 * - add a screen and forget to generate its baseline and the gate writes one
 *   silently on its next run, which is how a screenshot of a broken screen
 *   becomes the definition of correct,
 * - regenerate at the wrong viewport and the image is a picture of a different
 *   product. Width is the tell: 393 is the phone, 1280 the desktop, and
 *   anything else means the renderer was not the one this harness starts.
 *
 * Read as text rather than imported, because `apps/e2e` is not a dependency of
 * this workspace — the same technique, for the same reason, as
 * `a11y-coverage.test.ts` next door.
 */

const E2E_VISUAL_DIR = join(import.meta.dir, '..', '..', '..', '..', 'e2e', 'visual');
const SCREENS_FILE = join(E2E_VISUAL_DIR, 'screens.ts');
const BASELINE_DIR = join(E2E_VISUAL_DIR, '__screenshots__');

const VIEWPORT_WIDTH = { desktop: 1280, phone: 393 } as const;

interface DeclaredScreen {
  name: string;
  viewport: keyof typeof VIEWPORT_WIDTH;
  height?: number;
}

async function declaredScreens(): Promise<DeclaredScreen[]> {
  const source = await Bun.file(SCREENS_FILE).text();
  const body = source.slice(source.indexOf('VISUAL_SCREENS'));
  return [...body.matchAll(/name:\s*'([^']+)',[\s\S]*?viewport:\s*'(desktop|phone)',/g)].map(
    (match) => {
      const [entry, name, viewport] = match;
      const height = /height:\s*([\d_]+)/.exec(
        body.slice(match.index, match.index + entry.length + 200)
      );
      return {
        name: name as string,
        viewport: viewport as keyof typeof VIEWPORT_WIDTH,
        height: height ? Number(height[1]?.replace(/_/g, '')) : undefined,
      };
    }
  );
}

/** IHDR is the first chunk of every PNG: 8-byte signature, 4-byte length,
 *  4-byte type, then width and height as big-endian uint32. */
async function pngSize(path: string): Promise<{ width: number; height: number }> {
  const header = Buffer.from(await Bun.file(path).slice(0, 24).arrayBuffer());
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

describe('v3 visual-regression baselines', () => {
  test('screens.ts declares at least one screen', async () => {
    expect((await declaredScreens()).length).toBeGreaterThan(0);
  });

  test('every declared screen has a committed baseline, and vice versa', async () => {
    const declared = (await declaredScreens()).map((screen) => `${screen.name}.png`).sort();
    const committed = readdirSync(BASELINE_DIR)
      .filter((file) => file.endsWith('.png'))
      .sort();
    expect(committed).toEqual(declared);
  });

  test('every baseline was rendered at its screen’s viewport', async () => {
    const wrong: string[] = [];
    for (const screen of await declaredScreens()) {
      const size = await pngSize(join(BASELINE_DIR, `${screen.name}.png`));
      const width = VIEWPORT_WIDTH[screen.viewport];
      if (size.width !== width) {
        wrong.push(`${screen.name}: ${size.width}px wide, expected ${width} (${screen.viewport})`);
      }
      if (screen.height && size.height !== screen.height) {
        wrong.push(`${screen.name}: ${size.height}px tall, expected ${screen.height}`);
      }
    }
    expect(wrong, `baselines rendered at the wrong size:\n${wrong.join('\n')}`).toEqual([]);
  });
});

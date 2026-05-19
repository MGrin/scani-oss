/**
 * Optimizes product screenshots: each PNG captured by
 * `scripts/capture-landing-shots.ts` is downscaled and re-encoded to
 * AVIF + WebP, then the source PNG is removed. The screenshots ship at
 * 3200×2000 but display at ≤560 px, so this cuts the payload by ~95%.
 *
 * Run after a fresh capture (the capture-screenshots workflow does this
 * automatically) or manually via `bun run optimize:images`.
 */

import { readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

const SCREENSHOTS_DIR = resolve(import.meta.dir, '..', 'public', 'screenshots');
const MAX_WIDTH = 1440;

async function main(): Promise<void> {
  const pngs = (await readdir(SCREENSHOTS_DIR)).filter((f) => f.endsWith('.png'));
  if (pngs.length === 0) {
    console.log('No PNG screenshots to optimize.');
    return;
  }

  for (const file of pngs) {
    const src = join(SCREENSHOTS_DIR, file);
    const base = file.replace(/\.png$/, '');
    const pipeline = sharp(src).resize({ width: MAX_WIDTH, withoutEnlargement: true });
    await pipeline
      .clone()
      .avif({ quality: 55 })
      .toFile(join(SCREENSHOTS_DIR, `${base}.avif`));
    await pipeline
      .clone()
      .webp({ quality: 72 })
      .toFile(join(SCREENSHOTS_DIR, `${base}.webp`));
    await unlink(src);
    console.log(`  ${file} → ${base}.avif + ${base}.webp`);
  }

  console.log(`Optimized ${pngs.length} screenshot(s).`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

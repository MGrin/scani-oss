#!/usr/bin/env bun
/**
 * Recapture the README product screenshots from the public demo.
 *
 * The demo is what makes these reproducible: it is seeded from one fixture
 * and resets on a schedule, so a run today and a run next month produce the
 * same numbers. A local stack does not — the shots then depend on whatever
 * that session happened to seed, and nothing downstream can tell a current
 * screenshot from a stale one. The committed set drifted a full UI generation
 * behind the product (captured 2026-05-25, pre-v3) without any check firing,
 * because an out-of-date image is not a broken one.
 *
 *   cd apps/e2e && bun run shots:readme
 *   cd apps/e2e && bun run shots:readme -- --slugs=dashboard --themes=dark
 *   cd apps/e2e && bun run shots:readme -- --url=http://localhost:5173
 *
 * Writes `.github/assets/screenshots/<slug>-<theme>-desktop.webp`, which is
 * what README.md's <picture> elements reference by name. Needs `cwebp`
 * (`brew install webp`); Playwright emits PNG only.
 *
 * It lives here rather than in `scripts/` because `@playwright/test` is
 * declared in this workspace and nowhere else. The hoisted linker would have
 * let a root-level copy resolve `playwright` anyway and fail only the
 * declaration check, on the public mirror, which is the first thing an
 * outside contributor sees (SC-889).
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, type Page } from '@playwright/test';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const OUT_DIR = resolve(REPO_ROOT, '.github/assets/screenshots');

/**
 * `--url` rather than an env var, deliberately. `docs:check`'s env-coverage
 * scan reads every `process.env.X` under `apps/` and warns on any name absent
 * from `.env.example` or the env reference — and five tests assert
 * `all N checks passed`, so a warning here reddens the whole gate. Documenting
 * a capture-tool override beside the variables a self-hoster must set would be
 * the worse fix: it is not one of them.
 */
const DEMO_URL = (parseValue('url') ?? 'https://demo.scani.xyz').replace(/\/$/, '');

/**
 * Captured at 2x and downsampled to this, which supersamples the text. GitHub
 * renders a README image at roughly 830 CSS px, so 1440 still has headroom on
 * a retina display without shipping a 2880px asset in the clone.
 */
const WIDTH = 1440;
const VIEWPORT = { width: WIDTH, height: 900 };
const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

interface Shot {
  slug: string;
  path: string;
  /**
   * A heading the route renders only once its own data has resolved. Waiting
   * on the app shell photographs a skeleton instead, and a skeleton is a
   * plausible-looking screenshot rather than an error — which is the failure
   * mode this whole script exists to make visible.
   */
  ready: string;
}

const SHOTS: Shot[] = [
  // The dashboard renders no <h1>; "Top holdings" is the last card to resolve.
  { slug: 'dashboard', path: '/', ready: 'Top holdings' },
  { slug: 'holdings', path: '/holdings', ready: 'Holdings' },
  { slug: 'accounts', path: '/accounts', ready: 'Accounts' },
  { slug: 'money', path: '/payments', ready: 'Money' },
  { slug: 'integrations', path: '/integrations', ready: 'Connect a service' },
];

function parseValue(flag: string): string | null {
  const raw = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return raw ? raw.slice(flag.length + 3) : null;
}

function parseList(flag: string, known: string[]): string[] | null {
  const raw = process.argv.find((a) => a.startsWith(`--${flag}=`));
  if (!raw) return null;
  const picked = raw
    .slice(flag.length + 3)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const name of picked) {
    if (!known.includes(name)) {
      throw new Error(`Unknown --${flag} entry "${name}"; known: ${known.join(', ')}`);
    }
  }
  return picked;
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1500);
}

async function toWebp(pngPath: string, webpPath: string): Promise<void> {
  const proc = Bun.spawnSync([
    'cwebp',
    '-quiet',
    '-q',
    '82',
    '-resize',
    String(WIDTH),
    '0',
    pngPath,
    '-o',
    webpPath,
  ]);
  if (proc.exitCode !== 0) {
    throw new Error(
      `cwebp failed on ${pngPath} (exit ${proc.exitCode}). Install it with \`brew install webp\`.\n${new TextDecoder().decode(
        proc.stderr
      )}`
    );
  }
}

async function main(): Promise<void> {
  const slugs = parseList(
    'slugs',
    SHOTS.map((s) => s.slug)
  );
  const themes = (parseList('themes', [...THEMES]) ?? [...THEMES]) as Theme[];
  const shots = slugs ? SHOTS.filter((s) => slugs.includes(s.slug)) : SHOTS;

  await mkdir(OUT_DIR, { recursive: true });
  console.log(`capture-readme-shots: ${DEMO_URL} -> ${OUT_DIR}`);

  const browser = await chromium.launch();
  let written = 0;

  try {
    for (const theme of themes) {
      const context = await browser.newContext({
        viewport: VIEWPORT,
        deviceScaleFactor: 2,
        colorScheme: theme,
      });
      // ThemeProvider reads this before first paint and only falls back to
      // prefers-color-scheme when it is unset, so setting both is what makes
      // the theme deterministic rather than dependent on load order.
      await context.addInitScript((value) => {
        window.localStorage.setItem('scani-theme', value as string);
      }, theme);

      const page = await context.newPage();
      for (const shot of shots) {
        const url = `${DEMO_URL}${shot.path}`;
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page
          .getByRole('heading', { name: shot.ready, exact: true })
          .first()
          .waitFor({ state: 'visible', timeout: 30_000 });
        await settle(page);

        const stem = `${shot.slug}-${theme}-desktop`;
        const pngPath = resolve(OUT_DIR, `${stem}.png`);
        const webpPath = resolve(OUT_DIR, `${stem}.webp`);
        await writeFile(pngPath, await page.screenshot({ type: 'png' }));
        await toWebp(pngPath, webpPath);
        await rm(pngPath, { force: true });
        written += 1;
        console.log(`  ok ${stem}  ${url}`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }

  console.log(`capture-readme-shots: wrote ${written} file(s)`);
}

await main();

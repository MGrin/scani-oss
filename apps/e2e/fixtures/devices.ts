import { devices } from '@playwright/test';

/**
 * The viewport matrix, shared by `playwright.config.ts` (which turns each
 * entry into a Playwright project) and `scripts/shots.ts` (which turns each
 * entry into a browser context). One list so a device added here is
 * immediately available to both the spec suite and the screenshot harness.
 */
export const VIEWPORTS = [
  { name: 'chromium', device: 'Desktop Chrome' },
  { name: 'webkit', device: 'Desktop Safari' },
  { name: 'iphone', device: 'iPhone 15 Pro' },
  { name: 'ipad', device: 'iPad Mini' },
] as const;

export type ViewportName = (typeof VIEWPORTS)[number]['name'];

/**
 * Projects the spec suite runs by default. The mobile viewports are
 * deliberately excluded: v2 is a desktop layout, so running all 26 specs
 * against a 393px viewport would report layout noise as test failures and
 * quadruple the run. They stay opt-in via
 * `bunx playwright test --project=iphone <spec>` and are the default target
 * of `bun run shots`.
 */
export const DEFAULT_SPEC_PROJECTS: ViewportName[] = ['chromium', 'webkit'];

/** Viewports `bun run shots` captures when `--devices` isn't passed. */
export const DEFAULT_SHOT_DEVICES: ViewportName[] = ['iphone', 'ipad'];

export function viewportDescriptor(name: ViewportName) {
  const entry = VIEWPORTS.find((v) => v.name === name);
  if (!entry) {
    throw new Error(
      `Unknown viewport "${name}"; known: ${VIEWPORTS.map((v) => v.name).join(', ')}`
    );
  }
  return devices[entry.device];
}

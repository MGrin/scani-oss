import { describe, expect, test } from 'bun:test';

const CONFIGS = [
  'playwright.config.ts',
  'playwright.shots.config.ts',
  'playwright.visual.config.ts',
] as const;

// The visual config resolves the container endpoint AT IMPORT and throws
// without it. Importing it here is not a claim that a host run is allowed —
// it is how this file reads the config's own launch options at all.
process.env.PW_VISUAL_WS ??= 'ws://127.0.0.1:0/keychain-free-launch-test';

describe('Playwright launch options match each browser engine', () => {
  for (const file of CONFIGS) {
    test(`${file} keeps Chromium flags out of WebKit launches`, async () => {
      const config = (await import(`../${file}`)).default;
      expect(config.projects?.length).toBeGreaterThan(0);
      for (const project of config.projects ?? []) {
        const use = { ...config.use, ...project.use };
        const browser = use.browserName ?? use.defaultBrowserType ?? 'chromium';
        const args: string[] = use.launchOptions?.args ?? [];
        if (browser === 'chromium') {
          expect(args).toContain('--password-store=basic');
          expect(args).toContain('--use-mock-keychain');
        } else {
          expect(args).not.toContain('--password-store=basic');
          expect(args).not.toContain('--use-mock-keychain');
        }
      }
    });
  }
});

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

describe('every Playwright config launches Chromium without a keychain', () => {
  for (const file of CONFIGS) {
    test(`${file} passes --password-store=basic and --use-mock-keychain`, async () => {
      const config = (await import(`../${file}`)).default;
      const args: string[] = config.use?.launchOptions?.args ?? [];
      expect(args).toContain('--password-store=basic');
      expect(args).toContain('--use-mock-keychain');
    });
  }
});

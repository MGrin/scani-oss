import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

/**
 * EXIT 1 MEANS THE BUNDLE, AND NOTHING ELSE DOES (SC-1309).
 *
 * `publish-images-local.sh` reads this script's exit code as its verdict on the
 * frontend image. A missing browser used to exit 1 through an uncaught launch
 * throw, and the publish said "the frontend-app image renders nothing" over an
 * image that had built. Each could-not-look case below must be exit 3 and must
 * NOT say the page rendered nothing; the mounted page is the control that
 * shows the checker can still say yes.
 *
 * The blank-page arm (exit 1) is not here on purpose: it waits out the full
 * 20s mount ceiling, which is a fixed budget by design, and that is a cost on
 * every gate for a branch no code path here reaches differently.
 */

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'check-spa-boots.ts');
// An ELEMENT child: the checker counts `childElementCount`, so a text node is
// exactly the empty page it exists to catch.
const MOUNTS =
  '<div id="root"></div><script>document.getElementById("root").append(document.createElement("main"))</script>';

let server: ReturnType<typeof Bun.serve>;
const emptyBrowsers = mkdtempSync(join(tmpdir(), 'no-browsers-'));

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname === '/broken'
        ? new Response('upstream down', { status: 502 })
        : new Response(`<!doctype html><html><body>${MOUNTS}</body></html>`, {
            headers: { 'content-type': 'text/html' },
          }),
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(emptyBrowsers, { recursive: true, force: true });
});

async function check(url: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn(['bun', SCRIPT, url], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: `${out}${err}` };
}

/** A port that was just free: bind, read it, release. */
function deadUrl(): string {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
  const url = `http://127.0.0.1:${probe.port}/`;
  probe.stop(true);
  return url;
}

describe('check-spa-boots says COULD NOT CHECK when it could not look (SC-1309)', () => {
  test('the browser is not installed -> exit 3, naming the install command', async () => {
    const { code, out } = await check(`http://127.0.0.1:${server.port}/`, {
      PLAYWRIGHT_BROWSERS_PATH: emptyBrowsers,
    });
    expect(out).toContain('COULD NOT CHECK');
    expect(out).toContain('the browser is not installed');
    expect(out).toContain('bunx playwright install chromium-headless-shell');
    expect(out).toContain('The bundle was NOT assessed');
    expect(out).not.toContain('rendered nothing');
    expect(code).toBe(3);
  });

  test('nothing is listening (the container never came up) -> exit 3', async () => {
    const { code, out } = await check(deadUrl());
    expect(out).toContain('COULD NOT CHECK');
    expect(out).toContain('nothing answered');
    expect(out).not.toContain('rendered nothing');
    expect(code).toBe(3);
  });

  test('the server answers with an error, not the page -> exit 3', async () => {
    const { code, out } = await check(`http://127.0.0.1:${server.port}/broken`);
    expect(out).toContain('HTTP 502');
    expect(out).not.toContain('rendered nothing');
    expect(code).toBe(3);
  });
});

// The control needs a real browser. Where there is none it is skipped and SAYS
// so, because a skipped control is an unasserted green on the arms above. The
// probe is a launch, not a path check: headless launches use a different
// executable from the one `executablePath()` names.
const noBrowser = await chromium
  .launch({ args: ['--password-store=basic', '--use-mock-keychain'] })
  .then(
    async (browser) => {
      await browser.close();
      return null;
    },
    (error: unknown) => String(error).split('\n')[0]
  );
if (noBrowser !== null) {
  console.warn(`check-spa-boots.test: CONTROL NOT RUN — exit 0 was not observed: ${noBrowser}`);
}

describe('CONTROL: a page that mounts is still a pass', () => {
  test.skipIf(noBrowser !== null)('a mounted #root -> exit 0', async () => {
    const { code, out } = await check(`http://127.0.0.1:${server.port}/`);
    expect(out).toContain('mounted');
    expect(code).toBe(0);
  });
});

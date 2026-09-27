import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * THE PUBLISH SAYS "RENDERS NOTHING" ONLY WHEN THE CHECKER SAID SO (SC-1309).
 *
 * With Playwright's browser missing, `check-spa-boots.ts` exited 1 and the
 * publish refused with "the frontend-app image renders nothing" — a claim about
 * a bundle nobody had looked at. The checker now exits 3 when it could not
 * look, and this runs the SHIPPED `smoke_frontend_boots` — cut out of the
 * script, not transcribed — with docker, curl and bun stubbed, once per exit
 * code, so the mapping from checker to verdict is what is asserted.
 */

const SCRIPT = readFileSync(new URL('../publish-images-local.sh', import.meta.url), 'utf8');

function shipped(name: string): string {
  const start = SCRIPT.indexOf(`\n${name}() {`);
  const end = SCRIPT.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`no ${name}() in publish-images-local.sh`);
  return SCRIPT.slice(start + 1, end + 2);
}

const HELPERS = ['ok', 'die', 'log']
  .map((name) => SCRIPT.split('\n').find((line) => line.startsWith(`${name}()`)))
  .join('\n');

const bin = mkdtempSync(join(tmpdir(), 'publish-boot-check-'));
mkdirSync(join(bin, 'bin'));
for (const [tool, body] of Object.entries({
  docker: 'exit 0',
  curl: 'printf 200',
  // The checker: exits with whatever the test asks for.
  bun: 'exit "$CHECK_EXIT"',
})) {
  writeFileSync(join(bin, 'bin', tool), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, 'bin', tool), 0o755);
}

afterAll(() => rmSync(bin, { recursive: true, force: true }));

function publishWithChecker(exit: number): { code: number; out: string } {
  const program = `${HELPERS}\n${shipped('smoke_frontend_boots')}\nNAMESPACE=scani BUILDER=b\ndockerfile_for() { echo Dockerfile; }\nsmoke_frontend_boots\n`;
  const proc = Bun.spawnSync(['bash', '-c', program], {
    env: { ...process.env, PATH: `${join(bin, 'bin')}:/usr/bin:/bin`, CHECK_EXIT: String(exit) },
  });
  return { code: proc.exitCode ?? -1, out: `${proc.stdout}${proc.stderr}` };
}

describe('the publish reads the boot checker by exit code (SC-1309)', () => {
  test('CONTROL: the checker saw it mount (0) -> the publish goes on', () => {
    const { code, out } = publishWithChecker(0);
    expect(out).toContain('the frontend-app bundle mounts');
    expect(code).toBe(0);
  });

  test('the checker saw a blank page (1) -> "renders nothing", the finding the gate exists for', () => {
    const { code, out } = publishWithChecker(1);
    expect(out).toContain('renders nothing');
    expect(out).not.toContain('COULD NOT CHECK');
    expect(code).not.toBe(0);
  });

  test('the checker could not look (3) -> COULD NOT CHECK, and never "renders nothing"', () => {
    const { code, out } = publishWithChecker(3);
    expect(out).toContain('COULD NOT CHECK');
    expect(out).toContain('the bundle was NOT assessed');
    expect(out).not.toContain('renders nothing');
    expect(code).not.toBe(0);
  });

  test('any other exit (a crash) is neither verdict, and still refuses', () => {
    const { code, out } = publishWithChecker(7);
    expect(out).toContain('exited 7');
    expect(out).not.toContain('renders nothing');
    expect(code).not.toBe(0);
  });
});

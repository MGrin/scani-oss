/**
 * SC-280. Test files were invisible to `bun run type-check` for the whole life
 * of this repo: every workspace `tsconfig.json` includes `src` only, the root
 * one excludes `**\/*.test.ts`, and CLAUDE.md puts tests in a sibling `tests/`.
 * So a type-level assertion written in a test file compiled nowhere.
 *
 * That is not merely missing coverage. It let SC-266 ship five
 * `@ts-expect-error` lines documented as "each one FAILS THE BUILD the day its
 * line starts compiling" — a guard whose failing mode did not exist. When the
 * check was finally turned on, one of them was firing on nothing: the
 * `V3FilterOption` union it claimed to prove was never exclusive.
 *
 * Each workspace with tests now carries a `tsconfig.test.json` and its
 * `type-check` script points at it. The assertions below pin the two ways that
 * arrangement silently degrades back to nothing.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { Glob } from 'bun';

const ROOT = join(import.meta.dir, '..', '..');

/** JSONC — these configs carry comments, and `JSON.parse` will not have them. */
function parseJsonc(src: string): Record<string, unknown> {
  let out = '';
  let inStr = false;
  let inBlock = false;
  let inLine = false;
  let esc = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    const d = src[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && d === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === '/' && d === '/') {
      inLine = true;
      continue;
    }
    if (c === '/' && d === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** Workspaces that own at least one test file, by their tsconfig's directory. */
async function workspacesWithTests(): Promise<string[]> {
  const found = new Set<string>();
  for await (const file of new Glob('{apps,packages}/*/*/**/*.test.{ts,tsx}').scan(ROOT)) {
    if (file.includes('node_modules')) continue;
    // Walk up to the nearest directory holding a tsconfig.json.
    let dir = dirname(join(ROOT, file));
    while (dir.startsWith(ROOT) && dir !== ROOT) {
      if (existsSync(join(dir, 'tsconfig.json'))) {
        found.add(relative(ROOT, dir));
        break;
      }
      dir = dirname(dir);
    }
  }
  return [...found].sort();
}

const read = async (p: string) => parseJsonc(await Bun.file(join(ROOT, p)).text());

const TEST_CONFIG_INVOCATION = 'tsgo --noEmit -p tsconfig.test.json';

/**
 * Does `bun run type-check` for this workspace actually run the test config?
 *
 * Equality was the original rule and it made this arrangement unrepresentable:
 * `apps/frontend/docs` is an Astro workspace whose type-check is `astro check`,
 * the only thing that types `.astro` files and the content collections. Adding
 * a test there forced a choice between dropping that and not testing at all —
 * so the guard, as written, was a rule against Astro workspaces having tests.
 *
 * `&&` is accepted and `||` is not, which is the whole distinction: an
 * `&&`-chain runs every segment on the success path, so the test config is
 * still gated by the script that fans out. `||` runs it only when something
 * else failed, which is a check that usually does not happen — the defect this
 * file exists for, wearing a shell operator.
 */
function runsTheTestConfig(script: string | undefined): boolean {
  if (!script) return false;
  return script.split('&&').some((segment) => segment.trim() === TEST_CONFIG_INVOCATION);
}

describe('type-check actually sees the tests', () => {
  test('every workspace that has tests has a tsconfig.test.json', async () => {
    const missing = (await workspacesWithTests()).filter(
      (ws) => !existsSync(join(ROOT, ws, 'tsconfig.test.json'))
    );

    expect(missing).toEqual([]);
  });

  test('its type-check script is the one that runs, not a second command', async () => {
    // The trap this ticket is about is a check that exists and is not run.
    // `bun run type-check` fans out over each workspace's own script, so the
    // script IS the gate — a `type-check:tests` sitting beside it would be
    // exactly the original defect one layer up.
    const wrong: string[] = [];
    for (const ws of await workspacesWithTests()) {
      const pkg = (await read(join(ws, 'package.json'))) as { scripts?: Record<string, string> };
      if (!runsTheTestConfig(pkg.scripts?.['type-check'])) {
        wrong.push(`${ws}: ${pkg.scripts?.['type-check']}`);
      }
    }

    expect(wrong).toEqual([]);
  });

  test('the segment check still rejects the arrangement this ticket exists for', () => {
    // Paired with the arm above, which passes over the real tree and so can
    // only ever demonstrate acceptance. This one demonstrates refusal.
    expect(runsTheTestConfig(TEST_CONFIG_INVOCATION)).toBe(true);
    expect(runsTheTestConfig(`astro check && ${TEST_CONFIG_INVOCATION}`)).toBe(true);

    // The original defect: the test config is reachable, but not from the
    // script `bun run type-check` fans out to.
    expect(runsTheTestConfig('tsgo --noEmit')).toBe(false);
    expect(runsTheTestConfig('astro check')).toBe(false);
    expect(runsTheTestConfig(undefined)).toBe(false);
    // Named in a comment or an argument rather than run.
    expect(runsTheTestConfig(`echo "${TEST_CONFIG_INVOCATION}"`)).toBe(false);
    // Conditional on the previous command failing, so it does not always run.
    expect(runsTheTestConfig(`astro check || ${TEST_CONFIG_INVOCATION}`)).toBe(false);
  });

  /**
   * The failure that actually happened while building this, and the reason
   * these configs spell out an `exclude` they could otherwise inherit.
   *
   * `extends` does not merge `exclude` — it replaces it, and a config with no
   * `exclude` of its own takes the ROOT tsconfig's, which is
   * `["**\/*.test.ts", ...]`. Three workspaces came out that way and dropped
   * 94 of 403 test files while reporting success. `.test.tsx` was unaffected,
   * so the coverage hole was partial, which is worse: `@scani/ui` reported 13
   * of its 44 test files and looked like it was working.
   */
  test('each config excludes explicitly, so it cannot inherit the root test exclude', async () => {
    const bad: string[] = [];
    for (const ws of await workspacesWithTests()) {
      const cfg = (await read(join(ws, 'tsconfig.test.json'))) as {
        include?: string[];
        exclude?: string[];
      };
      if (!cfg.exclude) {
        bad.push(`${ws}: no explicit exclude — inherits the root's **/*.test.ts`);
        continue;
      }
      const excludesTests = cfg.exclude.some((e) => e.includes('.test.'));
      if (excludesTests) bad.push(`${ws}: exclude re-adds a test pattern`);
      if (!cfg.include?.some((i) => i.startsWith('tests'))) {
        bad.push(`${ws}: include does not reach tests/`);
      }
    }

    expect(bad).toEqual([]);
  });
});

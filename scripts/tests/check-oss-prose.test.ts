import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  EXIT_OK,
  EXIT_UNKNOWN,
  findInContent,
  findInLines,
  proseOf,
  readSentence,
  SCOPE,
  SIGNAL_COUNT,
  type SignalType,
  SPECIFIC,
  selfTest,
  sentencesOf,
  verifySignals,
} from '../check-oss-prose';

/**
 * SC-909. A sentence of accurate English describing our own deployment passes
 * every OSS guard this repository has, and `check-oss-figures.ts` says in its
 * own header that it cannot read prose. The route is the most ordinary one
 * there is: explaining WHY a change exists, using the incident that motivated
 * it. A migration comment taking that route is permanent.
 *
 * EVERY FIXTURE BELOW IS INVENTED, and that is load-bearing rather than tidy.
 * This file is published. A must-fire fixture quoting a real measurement would
 * BE the thing the guard reports, committed into the guard against it, in the
 * one repository it was supposed to stay out of. `1,208` and `81%` measure
 * nothing. `check-oss-figures.test.ts` reaches the same conclusion after
 * drafting the opposite, and `check-oss-internal-refs.test.ts` reaches it by
 * splitting its probes across a `${}` boundary.
 *
 * THE MUST-NOT-FIRE CORPUS IS NOT INVENTED, and could not be. It is the shapes
 * MEASURED as legitimate in `upstream/main` — a third-party API's paging cap, a
 * chart's axis label, `never once` about code that was not exercised, an `SC-`
 * key in front of a word that is also a noun. Those are the sentences a rule of
 * this kind fires on when it is one notch too loose, and each one below is a
 * notch somebody tried.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED: a ceiling on how many claims the tracked
 * tree contains. That number is in the guard's header as a measurement and it
 * belongs there. As an assertion it would turn an advisory into a
 * build-breaking refusal by the back door — the one outcome the design rules
 * out, because a false refusal on a good comment is what gets a guard disabled.
 */

/**
 * The process tests spawn `bun scripts/check-oss-prose.ts`, which spawns
 * several `git` calls of its own, so the cost is subprocess startup — which
 * amplifies under load far harder than CPU work. `bun run test` passes
 * `--timeout 30000`; a bare `bun test <path>` gets 5000ms and `bunfig.toml`
 * cannot raise it, because bun drops a `timeout` key from `[test]` silently
 * (SC-694). This call is the only budget that survives both invocations.
 */
setDefaultTimeout(30_000);

const ROOT = path.resolve(import.meta.dir, '..', '..');

/** One sentence, as one line of a TypeScript comment. */
function comment(sentence: string): { findings: ReturnType<typeof findInContent>['findings'] } {
  return findInContent('x.ts', `// ${sentence}\n`);
}

describe('a sentence is reported only when it carries BOTH axes', () => {
  /**
   * The four shapes SC-909 names, each as one sentence. A guard that catches
   * none of the shapes of the near-miss it exists for is answering a different
   * ticket.
   */
  test.each([
    ['an event count', 'Our monitoring recorded 1,208 of these in the window.'],
    ['a share of a monitoring volume', 'That is 81% of our error volume for the window.'],
    ['a claim about what production never did', 'Production has never once drained one.'],
    ['a count of rows in the running system', 'In production 12 rows carried the empty label.'],
    ['a vendor beside a measurement', 'Sentry grouped 1,208 of them into a single issue.'],
  ])('MUST FIRE — %s', (_shape, sentence) => {
    expect(readSentence(sentence)).not.toBeNull();
  });

  /**
   * MEASURED-LEGITIMATE SHAPES. Every one of these is drawn from the kind of
   * sentence `upstream/main` is made of, and each corresponds to a candidate
   * rule that was rejected on measurement:
   *
   *   a third-party window cap and a chart label — a time-boxed window reads 17
   *   lines upstream and not one of them is about our deployment;
   *
   *   `never once` about code — 11 lines upstream, ordinary English;
   *
   *   an `SC-` key in front of `records` — the one false positive this rule
   *   produced over 400 merges, which is why the counted-noun pattern carries a
   *   lookbehind;
   *
   *   a scope word with no measurement, and a measurement with no scope word —
   *   620 and 907 sentences upstream respectively, either of which alone would
   *   fire on a sixth of the repository.
   */
  test.each([
    ['a third-party paging cap', 'Bybit caps execution-list date filters at a 7-day span.'],
    ['a chart axis label', 'Net worth over the last 30 days, rising, is the shape.'],
    ['never once, about code', 'That field had never once been read by anything.'],
    ['an SC- key before a noun', 'SC-751 records the tie as missing.'],
    [
      'scope with no measurement',
      'Every EVM swap in production was emitted as an unrelated transfer.',
    ],
    ['a mode name, not the system', 'The demo-trading header is absent in production mode.'],
    ['a measurement with no scope', 'It took 7 files and 3 retries to land.'],
    ['the vendor as a dependency', 'Sentry appears in the CSP and in the env schema.'],
    ['our, with an ordinary noun', 'That is our code, our tests and our own error handling.'],
    ['a dotted version', 'Run bunx @biomejs/biome@2.4.12 check over it.'],
  ])('MUST NOT FIRE — %s', (_shape, sentence) => {
    expect(readSentence(sentence)).toBeNull();
  });

  test('one axis alone is never enough, in either direction', () => {
    expect(readSentence('Our monitoring is wired up.')).toBeNull();
    expect(readSentence('There were 1,208 of them.')).toBeNull();
  });
});

describe('the guard verifies itself before it reads anything', () => {
  test('every signal still matches its probe and misses its anti-probe', () => {
    expect(selfTest()).toEqual([]);
  });

  test('the denominator covers both axes', () => {
    expect(SIGNAL_COUNT).toBe(SCOPE.length + SPECIFIC.length);
    expect(SIGNAL_COUNT).toBeGreaterThan(0);
  });

  /**
   * The self-test has to be able to come back RED, or its green says nothing —
   * which is the failure the whole file is built around, one level up.
   */
  test('a signal that stopped matching its probe is named', () => {
    const dead: SignalType = {
      name: 'dead',
      pattern: /zzz-never-matches/,
      probe: 'this does not contain it',
      antiProbe: 'nor does this',
    };
    expect(verifySignals([dead])).toEqual(['dead: stopped matching its own probe']);
  });

  test('a signal that started matching its anti-probe is named', () => {
    const loose: SignalType = {
      name: 'loose',
      pattern: /./,
      probe: 'anything',
      antiProbe: 'also anything',
    };
    expect(verifySignals([loose])).toEqual(['loose: now matches its anti-probe']);
  });
});

describe('what counts as prose', () => {
  test.each([
    ['a line comment', 'x.ts', '  // in production 12 rows carried it'],
    ['a docblock continuation', 'x.ts', '   * in production 12 rows carried it'],
    ['a shell or yaml comment', 'x.sh', '# in production 12 rows carried it'],
    ['a SQL comment', 'x.sql', '-- in production 12 rows carried it'],
    ['an html comment', 'x.mdx', '<!-- in production 12 rows carried it -->'],
  ])('%s is prose', (_what, file, line) => {
    expect(proseOf(file, line)).toContain('in production 12 rows');
  });

  /**
   * Anchored at the start of the line, so a `//` inside a URL and a `--` inside
   * an expression are code. The value axis is `check-oss-figures.ts`'s job and
   * reading string literals here would duplicate it while adding the i18n
   * catalogues to the population.
   */
  test.each([
    ['a URL in a string', 'x.ts', "const u = 'https://example.test/a';"],
    ['a decrement', 'x.ts', 'count--;'],
    ['an ordinary statement', 'x.ts', 'const rows = 12;'],
    ['a markdown fence', 'a.md', '```ts'],
    ['a markdown table rule', 'a.md', '| --- | --- |'],
  ])('%s is not prose', (_what, file, line) => {
    expect(proseOf(file, line)).toBeNull();
  });

  test('markdown body text is prose', () => {
    expect(proseOf('a.md', 'In production 12 rows carried it.')).toBe(
      'In production 12 rows carried it.'
    );
  });
});

describe('sentences, and the paragraph they came from', () => {
  test('a wrapped comment is rejoined before it is split', () => {
    const { findings } = findInContent(
      'x.ts',
      ['// In production 12 rows carried the empty', '// label for a week.'].join('\n')
    );
    expect(findings).toHaveLength(1);
  });

  /**
   * The stated limit, asserted rather than left in a header: two signals in
   * ADJACENT sentences are not a claim. Widening to the paragraph is what makes
   * a long docblock co-occur by accident.
   */
  test('signals in adjacent sentences are not a claim', () => {
    expect(
      findInContent('x.ts', '// We saw it in production. There were 1,208 of them.\n').findings
    ).toEqual([]);
  });

  test('splitting keeps a decimal inside one sentence', () => {
    expect(sentencesOf(['it was 1.5 and then 2.5 rows'])).toHaveLength(1);
  });
});

describe('blocks, and the line they are reported at', () => {
  test('a claim is reported at the first line of its own block', () => {
    const { findings } = findInContent(
      'x.ts',
      ['const a = 1;', 'const b = 2;', '// In production 12 rows carried it.'].join('\n')
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(3);
  });

  /**
   * A regression, and the reason the block's first line is captured when the
   * block OPENS. Carrying it over from a flushed block reported line 0 — a
   * coordinate that opens nothing, on the one output a reader is meant to act
   * on.
   */
  test('no claim is ever reported at line 0', () => {
    const { findings } = findInContent(
      'x.ts',
      ['// a leading comment', 'const a = 1;', '// In production 12 rows carried it.'].join('\n')
    );
    expect(findings.every((f) => f.line >= 1)).toBe(true);
  });

  /**
   * Over a DIFF the added lines of two hunks arrive next to each other in the
   * list and are not adjacent in the file. Joining them manufactures a sentence
   * nobody wrote — which would be a false accusation, and a false accusation is
   * how a guard loses the benefit of the doubt on the true ones.
   */
  test('two non-adjacent added lines are not one paragraph', () => {
    const { findings } = findInLines([
      { path: 'x.ts', line: 4, text: '// We saw it in production' },
      { path: 'x.ts', line: 90, text: '// and there were 1,208 of them.' },
    ]);
    expect(findings).toEqual([]);
  });

  test('a claim carries which signal on each axis', () => {
    const [found] = comment('In production 12 rows carried the empty label.').findings;
    expect(found?.scope).toBe('in production');
    expect(found?.specific).toBe('a counted noun');
  });
});

/**
 * THE URGENT ROUTE. `scripts/migrate.ts` refuses the whole `db:migrate` run on
 * sha256 drift, for an edited applied migration and for a deleted one, with no
 * escape flag — so an applied migration's comment is permanent, and migrations
 * are mirrored. There is no later at which one gets fixed.
 */
describe('a migration comment is read', () => {
  test('a claim in a .sql comment is found', () => {
    const { findings } = findInContent(
      'packages/infra/db/src/migrations/0001_x.sql',
      [
        '-- In production 12 rows carried the empty label.',
        'ALTER TABLE x ADD COLUMN y text;',
      ].join('\n')
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(1);
  });
});

/**
 * The guard is published, so its own sources are exactly the place a probe or
 * an explanatory sentence becomes the thing it reports — permanently, in the
 * repository it exists to keep it out of. `check-oss-internal-refs.test.ts`
 * carries the same control for the same reason.
 */
describe("the guard's own sources carry no claim", () => {
  test.each([
    ['scripts/check-oss-prose.ts'],
    ['scripts/tests/check-oss-prose.test.ts'],
  ])('%s is clean', (rel) => {
    const found = findInContent(rel, readFileSync(path.join(ROOT, rel), 'utf8')).findings;
    expect(found.map((f) => `${f.path}:${f.line}  ${f.sentence}`)).toEqual([]);
  });
});

/**
 * END TO END, THROUGH THE REAL SCRIPT AND A REAL GIT INDEX, because everything
 * above tests pure functions and none of it proves the process reports. The
 * repository is built to look like the public mirror — no `upstream` remote and
 * no `.private-repo` marker — which is `scanScope`'s *this checkout IS the
 * mirror* arm, and the arm an upstream PR is actually made from.
 */
describe('the process', () => {
  const SCRIPT = path.resolve(import.meta.dir, '..', 'check-oss-prose.ts');

  function repo(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'scani-prose-'));
    for (const args of [
      ['init', '-q', '-b', 'main'],
      ['config', 'user.email', 't@example.com'],
      ['config', 'user.name', 'T'],
      ['config', 'commit.gpgsign', 'false'],
    ]) {
      const r = Bun.spawnSync(['git', ...args], { cwd: dir });
      if (!r.success) throw new Error(`git ${args[0]} failed`);
    }
    writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
    Bun.spawnSync(['git', 'add', '-A'], { cwd: dir });
    Bun.spawnSync(['git', 'commit', '-qm', 'seed'], { cwd: dir });
    return dir;
  }

  function stage(dir: string, file: string, body: string): void {
    const full = path.join(dir, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
    const r = Bun.spawnSync(['git', 'add', file], { cwd: dir });
    if (!r.success) throw new Error(`git add ${file} failed`);
  }

  function run(dir: string, args: string[] = []): { code: number; out: string } {
    const r = Bun.spawnSync(['bun', SCRIPT, ...args], {
      cwd: dir,
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const dec = new TextDecoder();
    return { code: r.exitCode ?? -1, out: dec.decode(r.stdout) + dec.decode(r.stderr) };
  }

  test('names the file and line of a staged claim', () => {
    const dir = repo();
    try {
      stage(dir, 'src/x.ts', '// In production 12 rows carried the empty label.\n');
      const { out } = run(dir);
      expect(out).toContain('src/x.ts:1');
      expect(out).toContain('in production');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * THE POSTURE, asserted rather than described. A false positive on prose is
   * cheap to override and a false refusal on a good comment is what gets a
   * guard switched off, so this one never refuses — and because it never
   * refuses there is no escape variable to set, and nothing to disable.
   */
  test('reporting a claim is still exit 0, and says ADVISORY', () => {
    const dir = repo();
    try {
      stage(dir, 'src/x.ts', '// In production 12 rows carried the empty label.\n');
      const { code, out } = run(dir);
      expect(out).toContain('ADVISORY');
      expect(code).toBe(EXIT_OK);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a clean staged change says PASS, which is a different word', () => {
    const dir = repo();
    try {
      stage(dir, 'src/x.ts', '// Bybit caps the filter at a 7-day span.\n');
      const { code, out } = run(dir);
      expect(out).toContain('PASS');
      expect(out).not.toContain('ADVISORY');
      expect(code).toBe(EXIT_OK);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The denominator is printed on every outcome, because `0 deployment
   * claim(s)` beside no count at all is indistinguishable from a run that read
   * nothing — the failure `scripts/lib/check-verdict.ts` exists to state once.
   */
  test('every verdict carries what it read', () => {
    const dir = repo();
    try {
      stage(dir, 'src/x.ts', '// Bybit caps the filter at a 7-day span.\n');
      expect(run(dir).out).toMatch(/signal\(s\) self-tested, \d+ prose sentence\(s\) read across/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Blindness gets its own code, so "could not tell" can never be read off a
   * transcript as "read it and it was clean". Never EXIT_OK, even though every
   * finding this check makes is advisory: an advisory that could not run is not
   * a quiet one, it is an absent one.
   */
  test('a directory that is not a repository is UNKNOWN, not clean', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'scani-prose-bare-'));
    try {
      const { code, out } = run(dir);
      expect(code).toBe(EXIT_UNKNOWN);
      expect(out).toContain('UNKNOWN');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a private checkout is SKIPPED and says why', () => {
    const dir = repo();
    try {
      writeFileSync(path.join(dir, '.private-repo'), '');
      stage(dir, 'src/x.ts', '// In production 12 rows carried the empty label.\n');
      const { code, out } = run(dir);
      expect(out).toContain('SKIPPED');
      expect(code).toBe(EXIT_OK);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The audit mode answers a DIFFERENT question from the hook — not *did this
   * change add one* but *how many are already here* — which is why it reads the
   * whole tree and why no hook calls it.
   */
  test('--scan reads tracked files rather than a diff', () => {
    const dir = repo();
    try {
      writeFileSync(
        path.join(dir, 'committed.ts'),
        '// In production 12 rows carried the empty label.\n'
      );
      Bun.spawnSync(['git', 'add', '-A'], { cwd: dir });
      Bun.spawnSync(['git', 'commit', '-qm', 'add'], { cwd: dir });
      const { code, out } = run(dir, ['--scan']);
      expect(out).toContain('committed.ts:1');
      expect(out).toContain('tracked file(s)');
      expect(code).toBe(EXIT_OK);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The hook is the only thing that runs this on an ordinary commit, and it is
 * the one place the inversion below can be got wrong: every other OSS block in
 * that file REFUSES on any non-zero status, and this one must not, because a
 * check that cannot refuse has nothing to escalate.
 */
describe('the hook calls it', () => {
  const hook = readFileSync(path.join(ROOT, '.githooks', 'pre-commit'), 'utf8');

  test('pre-commit runs it', () => {
    expect(hook).toContain('scripts/check-oss-prose.ts');
  });

  test('pre-commit does not fail the commit on it', () => {
    const block = hook.slice(hook.indexOf('check-oss-prose.ts'));
    const nextSection = block.indexOf('# --------');
    expect(block.slice(0, nextSection === -1 ? undefined : nextSection)).not.toContain('fail "');
  });
});

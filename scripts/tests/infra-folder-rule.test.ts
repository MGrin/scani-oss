import { describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * `packages/infra/` states its own contract in `AGENTS.md`: *pure system
 * concerns. No business knowledge; reusable in any TypeScript backend.* The
 * four category folders are not labels, they are a stated dependency
 * direction — business -> clients -> external world, with `infra/` underneath
 * knowing nothing.
 *
 * SC-528's inventory guard derives the package LIST from the tree, so a
 * package can no longer go missing from the docs. Nothing checked that a
 * package OBEYS its folder's rule, and SC-580 found one that did not: a
 * package under this heading reading `users` from `@scani/db/schema`. The
 * inversion is invisible from the outside — someone placing a new file reads
 * the heading, not the imports — which is exactly the shape that needs a
 * mechanical check rather than a sentence.
 *
 * WHAT IS BANNED, and each one is narrower than "anything domain-ish":
 *   - `@scani/db/schema` — the tables. `@scani/db` itself is NOT banned: the
 *     connection, `BaseRepository` and the migration runner are system
 *     concerns, and `packages/infra/db` is the package that owns the schema,
 *     so the rule cannot apply to it.
 *   - `@scani/domain` — services, repositories and use cases.
 *   - every workspace under `packages/business/`, DERIVED from the tree
 *     rather than listed. A list is what goes stale by somebody adding a
 *     package, which is the failure SC-528 was about.
 *
 * A CLEAN READING IS ONLY EVIDENCE IF THE SCAN COULD HAVE FIRED. Three arms
 * below, and the last two are what separate a working guard from one that
 * reports nothing: a fixture that MUST be found, a fixture that must NOT be
 * (a guard firing on every `@scani/*` import would pass the first arm alone),
 * and a census proving the real scan actually read files and resolved
 * specifiers.
 */

const REPO_ROOT = path.resolve(import.meta.dir, '../..');

interface Violation {
  readonly pkg: string;
  readonly file: string;
  readonly specifier: string;
}

interface Scan {
  readonly violations: readonly Violation[];
  /** Files the scan actually read — a zero here makes a clean reading vacuous. */
  readonly filesScanned: number;
  /** `@scani/*` specifiers seen and allowed, the control on the same run. */
  readonly allowedScaniImports: number;
}

function packageDirs(root: string, category: string): string[] {
  const base = path.join(root, 'packages', category);
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return [];
  }
  return entries
    .map((name) => path.join(base, name))
    .filter((dir) => statSync(dir).isDirectory() && existsFile(path.join(dir, 'package.json')));
}

function existsFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function packageName(dir: string): string {
  return (JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name: string })
    .name;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
  };
  for (const sub of ['src', 'tests']) {
    const start = path.join(dir, sub);
    try {
      if (statSync(start).isDirectory()) walk(start);
    } catch {
      // a package with no tests/ is normal
    }
  }
  return out;
}

/**
 * Every module specifier in the file: static imports, re-exports, `import()`.
 *
 * ANCHORED AT THE START OF A LINE, because the first cut of this guard was
 * not and read 26 violations that were PROSE. `packages/infra/queue` explains
 * its own boot contract in a doc comment — *"`import '@scani/jobs';` now
 * fails boot with a message naming it"* — and asserts that sentence in a test
 * (`expect(message).toContain("import '@scani/jobs'")`). A guard that counts
 * the documentation of a rule as a breach of it is one people switch off.
 */
function specifiersOf(content: string): string[] {
  const out: string[] = [];
  const statements = [
    /^[ \t]*(?:import|export)\s[\s\S]*?\sfrom\s*['"]([^'"\n]+)['"]/gm,
    /^[ \t]*import\s*['"]([^'"\n]+)['"]/gm,
    /^[ \t]*(?:await\s+)?import\(\s*['"]([^'"\n]+)['"]\s*\)/gm,
  ];
  for (const re of statements) {
    for (const m of content.matchAll(re)) if (m[1]) out.push(m[1]);
  }
  return out;
}

const reaches = (specifier: string, target: string): boolean =>
  specifier === target || specifier.startsWith(`${target}/`);

export function scanInfraFolderRule(root: string): Scan {
  const businessNames = packageDirs(root, 'business').map(packageName);
  const violations: Violation[] = [];
  let filesScanned = 0;
  let allowedScaniImports = 0;

  for (const dir of packageDirs(root, 'infra')) {
    const name = packageName(dir);
    const banned = [...businessNames, '@scani/domain'];
    // The schema owner cannot be banned from its own schema.
    if (name !== '@scani/db') banned.push('@scani/db/schema');

    for (const file of sourceFiles(dir)) {
      filesScanned += 1;
      for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
        if (!specifier.startsWith('@scani/')) continue;
        const hit = banned.find((target) => reaches(specifier, target));
        if (hit) violations.push({ pkg: name, file: path.relative(root, file), specifier });
        else allowedScaniImports += 1;
      }
    }

    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
      if (businessNames.includes(dep) || dep === '@scani/domain') {
        violations.push({
          pkg: name,
          file: `${path.relative(root, dir)}/package.json`,
          specifier: dep,
        });
      }
    }
  }

  return { violations, filesScanned, allowedScaniImports };
}

/** A two-package tree in the shape `scanInfraFolderRule` reads. */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'infra-folder-rule-'));
  const write = (rel: string, content: string): void => {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  write('packages/business/domain/package.json', JSON.stringify({ name: '@scani/domain' }));
  write('packages/business/domain/src/index.ts', 'export const x = 1;\n');
  write('packages/infra/widget/package.json', JSON.stringify({ name: '@scani/widget' }));
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  return dir;
}

describe('no package under packages/infra/ reaches into the business layer (SC-580)', () => {
  test('the real tree holds to its folder rule', () => {
    const scan = scanInfraFolderRule(REPO_ROOT);
    expect(scan.violations).toEqual([]);
  });

  // MUST-BE-FOUND. Without this arm, the reading above is equally consistent
  // with a scanner that resolves nothing.
  test('an infra package importing @scani/domain is reported', () => {
    const root = fixture({
      'packages/infra/widget/src/index.ts':
        "import { Thing } from '@scani/domain/services/Thing';\n",
    });
    const scan = scanInfraFolderRule(root);
    expect(scan.violations.map((v) => v.specifier)).toEqual(['@scani/domain/services/Thing']);
  });

  // MUST-BE-ABSENT, two ways. A guard that fired on every `@scani/*` import
  // would satisfy the arm above and be useless.
  test('infra-to-infra imports and the db package reading its own schema are not violations', () => {
    const root = fixture({
      'packages/infra/widget/src/index.ts':
        "import { logger } from '@scani/logging';\nimport { db } from '@scani/db';\n",
      'packages/infra/db/package.json': JSON.stringify({ name: '@scani/db' }),
      'packages/infra/db/src/index.ts': "export { users } from '@scani/db/schema';\n",
    });
    const scan = scanInfraFolderRule(root);
    expect(scan.violations).toEqual([]);
    expect(scan.allowedScaniImports).toBe(3);
  });

  // MUST-BE-ABSENT, the case measured on the real tree (see `specifiersOf`).
  test('a banned package NAMED in a comment or a string is not an import', () => {
    const root = fixture({
      'packages/infra/widget/src/index.ts': [
        "// Call AFTER `import '@scani/domain';` registers the concretes.",
        '/**',
        " * `import '@scani/domain';` now fails boot with a message naming it.",
        ' */',
        'export const hint = "import \'@scani/domain\';";',
        "import { logger } from '@scani/logging';",
        '',
      ].join('\n'),
    });
    const scan = scanInfraFolderRule(root);
    expect(scan.violations).toEqual([]);
    expect(scan.allowedScaniImports).toBe(1);
  });

  test('a business dependency declared in an infra manifest is reported even with no import', () => {
    const root = fixture({
      'packages/infra/widget/package.json': JSON.stringify({
        name: '@scani/widget',
        dependencies: { '@scani/domain': 'workspace:*' },
      }),
      'packages/infra/widget/src/index.ts': 'export const x = 1;\n',
    });
    expect(scanInfraFolderRule(root).violations.map((v) => v.specifier)).toEqual(['@scani/domain']);
  });

  // THE CENSUS. "No violations" over zero files is the failure this arm makes
  // impossible to mistake for a pass.
  test('the real scan read files and resolved @scani specifiers', () => {
    const scan = scanInfraFolderRule(REPO_ROOT);
    expect(scan.filesScanned).toBeGreaterThan(100);
    expect(scan.allowedScaniImports).toBeGreaterThan(10);
  });
});

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * `PriceWriter` is the only code that writes `token_prices` (foundation A3,
 * Task 6). The SQL stays in `TokenPriceRepository`, so there are two lists:
 * the files that may hold a statement writing the table, and the files that
 * may call the repository's write methods. Comments are stripped first, so a
 * file that explains a write is not flagged for quoting it.
 */

const ROOT = new URL('../../../../../../', import.meta.url).pathname;

/**
 * Where a write could be: application and package sources (migrations
 * included), and the scripts run by hand, an app's own as well as the root's.
 */
const SCOPES = [/^packages\/.+\/src\//, /^apps\/.+\/src\//, /^apps\/.+\/scripts\//, /^scripts\//];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'tests', 'test', 'coverage']);
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|sql|sh)$/;

const STATEMENT_ALLOWED = [
  'apps/e2e/scripts/seed-cold-boot.ts',
  'packages/business/domain/src/demo/DemoDatasetSeeder.ts',
  'packages/business/domain/src/repositories/TokenPriceRepository.ts',
  // Applied migrations, by name: each ran once and can never change (SC-914),
  // so a new one that writes the table is what this list exists to catch.
  'packages/infra/db/src/migrations/0004_merge_mistyped_equity_dupes.sql',
  'packages/infra/db/src/migrations/0006_generalized_stock_dedup.sql',
  'packages/infra/db/src/migrations/0007_merge_chain_spread_crypto.sql',
  'packages/infra/db/src/migrations/0016_ibkr_segment_token_dedup.sql',
  'packages/infra/db/src/migrations/0017_purge_crosstype_price_pollution.sql',
  'packages/infra/db/src/migrations/0028_restore_downsampled_manual_price_source.sql',
  // A finished repair (SC-389): deletes the rows written under a wrong id.
  'scripts/lib/sc389-contradicted-ids.ts',
];

const REPOSITORY_CALL_ALLOWED = [
  // The downsampler writes through the repository until PR-8 deletes it.
  'apps/backend/worker/src/processors/token-prices-downsample.ts',
  'packages/business/domain/src/services/pricing/PriceWriter.ts',
];

/** The table in a raw statement: by name, quoted or schema-qualified, or interpolated. */
const TABLE = String.raw`(?:(?:"?public"?\.)?"?token_prices\b"?|\$\{\s*(?:schema\s*\.\s*)?tokenPrices\s*\})`;
const raw = (verb: string) => new RegExp(String.raw`\b${verb}\s+${TABLE}`, 'gi');
/** TRUNCATE takes a list, so the table may follow any number of others. */
const truncate = new RegExp(
  String.raw`\btruncate(?:\s+table)?\s+(?:(?:only\s+)?[\w."$\{\}]+\s*,\s*)*(?:only\s+)?${TABLE}`,
  'gi'
);
/** `COPY t FROM` loads rows; `COPY t TO` only reads them. A column list may sit between. */
const copyFrom = new RegExp(String.raw`\bcopy\s+${TABLE}\s*(?:\([^)]*\)\s*)?from\b`, 'gi');

const STATEMENT_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  {
    name: 'drizzle write',
    pattern: /\.\s*(?:insert|update|delete)\s*\(\s*(?:schema\s*\.\s*)?tokenPrices\b/g,
  },
  { name: 'INSERT INTO', pattern: raw(String.raw`insert\s+into`) },
  { name: 'UPDATE', pattern: raw('update') },
  { name: 'UPDATE ONLY', pattern: raw(String.raw`update\s+only`) },
  { name: 'DELETE FROM', pattern: raw(String.raw`delete\s+from(?:\s+only)?`) },
  { name: 'TRUNCATE', pattern: truncate },
  { name: 'COPY FROM', pattern: copyFrom },
  { name: 'MERGE INTO', pattern: raw(String.raw`merge\s+into`) },
];

const REPOSITORY_ONLY_METHOD = 'repository-only method';
const PRICE_REPOSITORY_RECEIVER = 'price-repository receiver';

/** Every pattern the scan can report, by the name a finding carries. */
const DECLARED_PATTERNS = [
  ...STATEMENT_PATTERNS.map(({ name }) => name),
  REPOSITORY_ONLY_METHOD,
  PRICE_REPOSITORY_RECEIVER,
];

/** Names that only the price repository carries, so any receiver counts. */
const OWN_WRITE_METHODS = /\.\s*(?:bulkUpsertDailyBackfill|downsampleIntradayToDaily)\s*\(/g;
/** Write methods every repository has, so only a price-repository receiver counts. */
const SHARED_WRITE_METHODS = '(?:bulkUpsert|create|createMany|update|delete)';
const RECEIVER_BINDINGS = [
  /\b(\w+)\s*=\s*Container\.get\(\s*TokenPriceRepository\s*\)/g,
  /\b(\w+)\s*=\s*new\s+TokenPriceRepository\s*\(/g,
  /\b(\w+)\s*\??:\s*TokenPriceRepository\b/g,
];

function stripComments(file: string, source: string): string {
  const blocks = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return file.endsWith('.sql')
    ? blocks.replace(/--.*$/gm, '')
    : blocks.replace(/(^|\s)\/\/.*$/gm, '$1');
}

function receiversIn(code: string): string[] {
  const names = new Set(['tokenPriceRepository']);
  for (const binding of RECEIVER_BINDINGS) {
    for (const match of code.matchAll(binding)) names.add(match[1] as string);
  }
  return [...names];
}

interface Finding {
  file: string;
  kind: 'statement' | 'repository call';
  pattern: string;
  match: string;
}

function scanSource(file: string, source: string): Finding[] {
  const code = stripComments(file, source);
  const findings: Finding[] = [];
  for (const { name, pattern } of STATEMENT_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      findings.push({
        file,
        kind: 'statement',
        pattern: name,
        match: match[0].replace(/\s+/g, ' '),
      });
    }
  }
  const receivers = receiversIn(code).join('|');
  const sharedCalls = new RegExp(
    `(?:\\b(?:${receivers})|Container\\.get\\(\\s*TokenPriceRepository\\s*\\))\\s*\\.\\s*${SHARED_WRITE_METHODS}\\s*\\(`,
    'g'
  );
  const calls = [
    { name: REPOSITORY_ONLY_METHOD, pattern: OWN_WRITE_METHODS },
    { name: PRICE_REPOSITORY_RECEIVER, pattern: sharedCalls },
  ];
  for (const { name, pattern } of calls) {
    for (const match of code.matchAll(pattern)) {
      findings.push({
        file,
        kind: 'repository call',
        pattern: name,
        match: match[0].replace(/\s+/g, ''),
      });
    }
  }
  return findings;
}

/** Whether a repository path is one the scan reads. */
function inScope(file: string): boolean {
  const segments = file.split('/');
  return (
    SCOPES.some((scope) => scope.test(file)) &&
    !segments.some((segment) => segment.startsWith('.') || SKIPPED_DIRS.has(segment)) &&
    SOURCE_FILE.test(file) &&
    !/\.test\.[cm]?[jt]sx?$/.test(file)
  );
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || SKIPPED_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (SOURCE_FILE.test(entry) && !/\.test\.[cm]?[jt]sx?$/.test(entry)) out.push(path);
  }
  return out;
}

function scanRepository(): { filesScanned: number; findings: Finding[] } {
  const files = ['packages', 'apps', 'scripts']
    .flatMap((top) => sourceFiles(join(ROOT, top)))
    .map((path) => relative(ROOT, path).split(sep).join('/'))
    .filter(inScope)
    .sort();
  return {
    filesScanned: files.length,
    findings: files.flatMap((file) => scanSource(file, readFileSync(join(ROOT, file), 'utf8'))),
  };
}

function filesWith(findings: Finding[], kind: Finding['kind']): string[] {
  return [...new Set(findings.filter((f) => f.kind === kind).map((f) => f.file))].sort();
}

describe('PriceWriter is the only writer of token_prices', () => {
  test('the scan reads the sources, so a clean result is not vacuous', () => {
    const { filesScanned, findings } = scanRepository();
    expect(filesScanned).toBeGreaterThan(1000);
    expect(filesWith(findings, 'statement')).toContain(
      'packages/business/domain/src/repositories/TokenPriceRepository.ts'
    );
  });

  test('the only writers of token_prices are the allowed ones', () => {
    const { findings } = scanRepository();

    // Exact, so an entry for a file that no longer writes goes red too.
    expect(filesWith(findings, 'statement')).toEqual(STATEMENT_ALLOWED);
    expect(filesWith(findings, 'repository call')).toEqual(REPOSITORY_CALL_ALLOWED);
  });

  test('the scope covers migrations and every app’s scripts, and no test', () => {
    expect(inScope('packages/infra/db/src/migrations/20991231000000_zz_probe.sql')).toBe(true);
    expect(inScope('apps/backend/worker/scripts/zz-probe.ts')).toBe(true);
    expect(inScope('apps/e2e/scripts/zz-probe.ts')).toBe(true);
    expect(inScope('scripts/lib/zz-probe.ts')).toBe(true);
    expect(inScope('packages/business/domain/tests/zz-probe.ts')).toBe(false);
    expect(inScope('packages/business/domain/src/zz-probe.test.ts')).toBe(false);
  });

  test('CONTROL: each pattern reports a file that uses it, and names itself', () => {
    const fixtures: Array<[file: string, source: string, pattern: string]> = [
      ['a.ts', 'await db.insert(schema.tokenPrices).values(rows);', 'drizzle write'],
      ['a.ts', 'await tx.update(tokenPrices).set({ price });', 'drizzle write'],
      ['a.ts', 'await db\n  .delete(schema.tokenPrices)\n  .where(x);', 'drizzle write'],
      [
        'a.ts',
        "await db.execute(sql`INSERT INTO token_prices (price) VALUES ('1')`);",
        'INSERT INTO',
      ],
      [
        'a.ts',
        `await db.execute(sql\`insert into \${schema.tokenPrices} (price) values (1)\`);`,
        'INSERT INTO',
      ],
      ['a.ts', "await db.execute(sql`update public.token_prices set price = '2'`);", 'UPDATE'],
      ['a.ts', "await db.execute(sql`UPDATE ONLY token_prices SET price = '2'`);", 'UPDATE ONLY'],
      [
        'a.ts',
        'await sql.unsafe(\'DELETE FROM "token_prices" WHERE id = $1\', [id]);',
        'DELETE FROM',
      ],
      ['a.ts', 'await db.execute(sql`DELETE FROM ONLY token_prices WHERE true`);', 'DELETE FROM'],
      ['a.ts', 'await db.execute(sql`TRUNCATE TABLE token_prices`);', 'TRUNCATE'],
      ['a.ts', 'await db.execute(sql`TRUNCATE token_prices`);', 'TRUNCATE'],
      ['a.ts', 'await db.execute(sql`truncate only token_prices`);', 'TRUNCATE'],
      ['a.ts', 'await db.execute(sql`TRUNCATE holdings, token_prices CASCADE`);', 'TRUNCATE'],
      [
        'a.ts',
        `await db.execute(sql\`TRUNCATE TABLE ONLY \${schema.holdings}, ONLY \${schema.tokenPrices}\`);`,
        'TRUNCATE',
      ],
      ['m.sql', "COPY token_prices FROM '/tmp/prices.csv' WITH (FORMAT csv);", 'COPY FROM'],
      ['m.sql', 'COPY public.token_prices (token_id, price) FROM STDIN;', 'COPY FROM'],
      ['a.ts', 'await db.execute(sql`merge into token_prices t using s on true`);', 'MERGE INTO'],
      [
        'm.sql',
        'DELETE FROM token_prices WHERE token_id = x; -- UPDATE token_prices',
        'DELETE FROM',
      ],
      ['a.ts', 'await this.tokenPriceRepository.bulkUpsert(rows);', 'price-repository receiver'],
      ['a.ts', 'await this.tokenPriceRepository.create(row, tx);', 'price-repository receiver'],
      ['a.ts', 'await repo.downsampleIntradayToDaily(7, tx);', 'repository-only method'],
      ['a.ts', 'await repo.bulkUpsertDailyBackfill(rows);', 'repository-only method'],
      [
        'a.ts',
        'const prices = Container.get(TokenPriceRepository);\nawait prices.bulkUpsert(rows);',
        'price-repository receiver',
      ],
      [
        'a.ts',
        'const repo = new TokenPriceRepository();\nawait repo.update(id, row);',
        'price-repository receiver',
      ],
      [
        'a.ts',
        'constructor(private readonly prices: TokenPriceRepository) {}\nawait this.prices.delete(id);',
        'price-repository receiver',
      ],
      [
        'a.ts',
        'await Container.get(TokenPriceRepository).createMany(rows);',
        'price-repository receiver',
      ],
    ];

    const reported = fixtures.map(([file, source]) =>
      scanSource(file, source).map((finding) => finding.pattern)
    );

    expect(reported).toEqual(fixtures.map(([, , pattern]) => [pattern]));
    // Every declared pattern fired on some fixture: one with no fixture could
    // stop matching and nothing here would say so.
    expect([...new Set(reported.flat())].sort()).toEqual([...DECLARED_PATTERNS].sort());
  });

  test('CONTROL: reads, other repositories and comments are not writes', () => {
    const source = [
      'await db.select().from(schema.tokenPrices).where(x);',
      'await db.execute(sql`SELECT 1 FROM token_prices p`);',
      'await db.execute(sql`INSERT INTO token_price_edit_history (x) VALUES (1)`);',
      '.onConflictDoUpdate({ target, set: { price: sql`EXCLUDED.price` } });',
      'await db.execute(sql`ON CONFLICT (id) DO UPDATE SET price = EXCLUDED.price`);',
      'await this.transactionRepository.bulkUpsert(rows);',
      'await this.tokenPriceEditHistoryRepository.create(row, tx);',
      '// INSERT INTO token_prices is what this comment is about',
      '/* this.tokenPriceRepository.bulkUpsert(rows) */',
      'await db.execute(sql`ALTER TABLE token_prices ADD CONSTRAINT c CHECK (true)`);',
      'await db.execute(sql`TRUNCATE holdings, token_price_edit_history`);',
      'await db.execute(sql`COPY token_prices TO STDOUT`);',
      'await db.execute(sql`COPY holdings FROM STDIN`);',
    ].join('\n');
    const migration = [
      '-- UPDATE token_prices is only described here',
      'SELECT count(*) FROM token_prices;',
      'ALTER TABLE token_prices VALIDATE CONSTRAINT c;',
    ].join('\n');

    expect(scanSource('fixture.ts', source)).toEqual([]);
    expect(scanSource('fixture.sql', migration)).toEqual([]);
  });
});

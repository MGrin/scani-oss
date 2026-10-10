// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures are source the scanner
// reads, so their `${…}` placeholders are the point.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * `PriceReader` is the only path a price takes to a number a user sees
 * (foundation A3, Task 24). Two lists say so: the files that may hold a
 * statement reading `token_prices`, and the files that may use
 * `TokenPriceRepository`. Every other entry is a read that prices nothing:
 * whether a reading exists, which days are stored, what to fetch next. Comments
 * are stripped first, so a file that explains a read is not flagged for it.
 *
 * Scripts and migrations are outside the scope: scripts are run by hand and no
 * user's number comes from one, and an applied migration never changes (SC-914).
 */

const ROOT = new URL('../../../../../../', import.meta.url).pathname;

const SCOPES = [/^packages\/.+\/src\//, /^apps\/.+\/src\//];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'tests', 'test', 'coverage', 'migrations']);
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

const STATEMENT_ALLOWED = [
  // Whether a token was ever quoted, for the data-quality report (SC-146).
  'apps/backend/api/src/presentation/routers/portfolio.ts',
  // The engine's loader: what `PriceReader` reads.
  'packages/business/domain/src/repositories/EngineEvidenceRepository.ts',
  'packages/business/domain/src/repositories/TokenPriceRepository.ts',
  // The currencies a typed price is quoted in, and whether a token was ever quoted.
  'packages/business/domain/src/repositories/TokenRepository.ts',
  // A cache key: which readings exist, not what anything is worth.
  'packages/business/domain/src/services/portfolio/PortfolioValueVersion.ts',
  // The benchmark backfill's stored first and last day.
  'packages/business/domain/src/use-cases/BackfillBenchmarkPricesUseCase.ts',
  // The backfill's stored days.
  'packages/business/domain/src/use-cases/BackfillHistoricalPricesUseCase.ts',
];

const REPOSITORY_ALLOWED = [
  'packages/business/domain/src/repositories/TokenPriceRepository.ts',
  'packages/business/domain/src/repositories/index.ts',
  // The backfill's stored days.
  'packages/business/domain/src/services/pricing/HistoricalPriceBackfillService.ts',
  'packages/business/domain/src/services/pricing/PriceWriter.ts',
  // What to fetch: a token with a current reading is not asked again.
  'packages/business/domain/src/services/pricing/PricingService.ts',
  // The manual price history.
  'packages/business/domain/src/services/tokens/TokenPriceHistoryService.ts',
  'packages/business/domain/src/use-cases/BackfillHistoricalPricesUseCase.ts',
  // A hand-valued holding's typed price, in the currency it was typed in.
  'packages/business/domain/src/use-cases/HandValuedHoldingUseCase.ts',
  // What to fetch: a stock or FX reading that is not due yet (SC-1603).
  'packages/business/domain/src/use-cases/UpdateTokenPricesUseCase.ts',
];

/** The table in a raw statement: by name, quoted or schema-qualified, or interpolated. */
const TABLE = String.raw`(?:(?:"?public"?\.)?"?token_prices\b"?|\$\{\s*(?:schema\s*\.\s*)?tokenPrices\s*\})`;

const STATEMENT_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  {
    name: 'drizzle select',
    pattern:
      /\.\s*(?:from|innerJoin|leftJoin|rightJoin|fullJoin)\s*\(\s*(?:schema\s*\.\s*)?tokenPrices\b/g,
  },
  { name: 'drizzle query', pattern: /\bquery\s*\.\s*tokenPrices\s*\./g },
  // Not after DELETE: `DELETE FROM token_prices` is a write, and the writer test owns it.
  {
    name: 'FROM',
    pattern: new RegExp(String.raw`(?<!\bdelete\s+)\bfrom\s+(?:only\s+)?${TABLE}`, 'gi'),
  },
  { name: 'JOIN', pattern: new RegExp(String.raw`\bjoin\s+(?:lateral\s+)?${TABLE}`, 'gi') },
];

const REPOSITORY_CLASS = 'repository class';
const REPOSITORY_ONLY_METHOD = 'repository-only method';

/** Every pattern the scan can report, by the name a finding carries. */
const DECLARED_PATTERNS = [
  ...STATEMENT_PATTERNS.map(({ name }) => name),
  REPOSITORY_CLASS,
  REPOSITORY_ONLY_METHOD,
];

/** Names that only the price repository carries, so any receiver counts. */
const OWN_READ_METHODS =
  /\.\s*(?:findLatestPrice|findLatestPricesForTokens|findLatestManualPricesForTokensAnyBase|findLatestPricesAtOrBefore|findPricesAtKeys|findPricedDayKeys)\s*\(/g;
const CLASS_NAME = /\bTokenPriceRepository\b/g;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

interface Finding {
  file: string;
  kind: 'statement' | 'repository';
  pattern: string;
  match: string;
}

function scanSource(file: string, source: string): Finding[] {
  const code = stripComments(source);
  const findings: Finding[] = [];
  const add = (kind: Finding['kind'], pattern: string, match: string) =>
    findings.push({ file, kind, pattern, match: match.replace(/\s+/g, ' ') });
  for (const { name, pattern } of STATEMENT_PATTERNS) {
    for (const match of code.matchAll(pattern)) add('statement', name, match[0]);
  }
  for (const match of code.matchAll(CLASS_NAME)) add('repository', REPOSITORY_CLASS, match[0]);
  for (const match of code.matchAll(OWN_READ_METHODS)) {
    add('repository', REPOSITORY_ONLY_METHOD, match[0]);
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
    else if (SOURCE_FILE.test(entry)) out.push(path);
  }
  return out;
}

function scanRepository(): { filesScanned: number; findings: Finding[] } {
  const files = ['packages', 'apps']
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

describe('PriceReader is the only reader of token_prices', () => {
  test('the scan reads the sources, so a clean result is not vacuous', () => {
    const { filesScanned, findings } = scanRepository();
    expect(filesScanned).toBeGreaterThan(1000);
    expect(filesWith(findings, 'statement')).toContain(
      'packages/business/domain/src/repositories/EngineEvidenceRepository.ts'
    );
  });

  test('no module outside the allowed list reads token_prices', () => {
    const { findings } = scanRepository();

    // Exact, so an entry for a file that no longer reads goes red too.
    expect(filesWith(findings, 'statement')).toEqual(STATEMENT_ALLOWED);
    expect(filesWith(findings, 'repository')).toEqual(REPOSITORY_ALLOWED);
  });

  test('the scope is the code a user’s numbers come from: no script, migration or test', () => {
    expect(inScope('packages/business/domain/src/services/zz-probe.ts')).toBe(true);
    expect(inScope('apps/backend/api/src/zz-probe.ts')).toBe(true);
    expect(inScope('apps/frontend/app/src/v3/zz-probe.tsx')).toBe(true);
    expect(inScope('scripts/lib/zz-probe.ts')).toBe(false);
    expect(inScope('packages/infra/db/src/migrations/zz-probe.ts')).toBe(false);
    expect(inScope('packages/business/domain/tests/zz-probe.ts')).toBe(false);
    expect(inScope('packages/business/domain/src/zz-probe.test.ts')).toBe(false);
  });

  test('CONTROL: a module that selects from token_prices to price a holding is reported', () => {
    const fixtures: Array<[source: string, pattern: string]> = [
      ['const [p] = await db.select().from(schema.tokenPrices).where(x);', 'drizzle select'],
      ['await db\n  .select()\n  .from(tokenPrices)\n  .limit(1);', 'drizzle select'],
      [
        'await db.select().from(schema.holdings).innerJoin(schema.tokenPrices, on);',
        'drizzle select',
      ],
      ['await db.select().from(h).leftJoin(tokenPrices, on);', 'drizzle select'],
      ['await db.query.tokenPrices.findFirst({ where });', 'drizzle query'],
      ['await db.execute(sql`SELECT price FROM token_prices WHERE token_id = ${id}`);', 'FROM'],
      ['await db.execute(sql`select price from public."token_prices" tp`);', 'FROM'],
      ['await db.execute(sql`SELECT p.price FROM ${schema.tokenPrices} p`);', 'FROM'],
      ['await db.execute(sql`SELECT 1 FROM holdings h JOIN token_prices p ON true`);', 'JOIN'],
      [
        'await db.execute(sql`SELECT 1 FROM h CROSS JOIN LATERAL (SELECT 1) x LEFT JOIN ${tokenPrices} p ON true`);',
        'JOIN',
      ],
      ['import { TokenPriceRepository } from "../repositories";', REPOSITORY_CLASS],
      ['const prices = Container.get(TokenPriceRepository);', REPOSITORY_CLASS],
      ['await deps.prices.findLatestPricesForTokens(ids, usd);', REPOSITORY_ONLY_METHOD],
      ['await this.store.findPricedDayKeys({ tokenIds });', REPOSITORY_ONLY_METHOD],
    ];

    const reported = fixtures.map(([source]) =>
      scanSource('a.ts', source).map((finding) => finding.pattern)
    );

    expect(reported).toEqual(fixtures.map(([, pattern]) => [pattern]));
    // Every declared pattern fired on some fixture: one with no fixture could
    // stop matching and nothing here would say so.
    expect([...new Set(reported.flat())].sort()).toEqual([...DECLARED_PATTERNS].sort());
  });

  test('CONTROL: writes, other tables and comments are not reads', () => {
    const source = [
      'await db.insert(schema.tokenPrices).values(rows);',
      'await db.execute(sql`DELETE FROM token_prices WHERE id = ${id}`);',
      'await db.execute(sql`delete from only token_prices where true`);',
      'await db.select().from(schema.tokenPriceEditHistory).where(x);',
      'await db.execute(sql`SELECT 1 FROM token_price_restamps`);',
      'await db.execute(sql`SELECT 1 FROM token_price_edit_history h`);',
      'await this.tokenPriceHistoryRepository.findByToken(id);',
      '// SELECT price FROM token_prices is what this comment is about',
      '/* Container.get(TokenPriceRepository).findLatestPrice(a, b) */',
    ].join('\n');

    expect(scanSource('fixture.ts', source)).toEqual([]);
  });
});

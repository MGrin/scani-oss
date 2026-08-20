import { describe, expect, test } from 'bun:test';
import {
  SCAM_SCORE_VERSION,
  ScamTokenDetectionService,
} from '../../../src/services/tokens/ScamTokenDetectionService';

/**
 * SC-286. Recomputing a stored score is only safe because
 * `calculateScamProbability` is a pure function of the token's own characters.
 * That is a property the code has to keep having, not a fact established once
 * in a ticket — so it is asserted here rather than asserted in prose.
 *
 * The bar it protects: if someone gives the function a second input that is a
 * fact about *us* rather than about the token, recomputation stops being
 * idempotent and the nightly job starts rewriting scores for reasons the token
 * had no part in. That is exactly SC-207, which awarded 0.3 for "no pricing
 * data available" and made a token's scam score fall when our coverage
 * improved.
 */

const SERVICE_SRC = new URL(
  '../../../src/services/tokens/ScamTokenDetectionService.ts',
  import.meta.url
).pathname;

const detector = new ScamTokenDetectionService();

const CASES: Array<[string, string]> = [
  ['USCON', 'United States Covert Operations Network'],
  ['CLAIM', 'Visit claim-airdrop.xyz for your free reward'],
  ['USDC', 'USD Coin'],
  ['USDС', 'USD Coin'], // Cyrillic С — a homoglyph
  ['BTC', 'Bitcoin'],
  ['🚀MOON', 'Moon Rocket Giveaway'],
];

describe('the function is deterministic in the token characters alone', () => {
  test('repeated calls with identical inputs return identical scores', async () => {
    for (const [symbol, name] of CASES) {
      const at = new Date('2026-08-16T00:00:00Z');
      const first = detector.calculateScamProbability(symbol, name, at);
      for (let i = 0; i < 5; i++) {
        expect(detector.calculateScamProbability(symbol, name, at)).toBe(first);
      }
    }
  });

  test('createdAt does not move the score — the third parameter is vestigial', async () => {
    // Stronger than "deterministic in (symbol, name, createdAt)": the
    // parameter is `_createdAt`, unused, because check 5 ("common symbol but
    // created recently") was disabled — it measured when OUR row was inserted,
    // not the age of the asset. So the score is a function of two strings, and
    // recomputing a ten-year-old row is identical to scoring it today.
    const spread = [
      new Date(0),
      new Date('1999-12-31T23:59:59Z'),
      new Date('2026-08-16T12:00:00Z'),
      new Date('2099-01-01T00:00:00Z'),
    ];
    for (const [symbol, name] of CASES) {
      const scores = spread.map((d) => detector.calculateScamProbability(symbol, name, d));
      expect(new Set(scores).size).toBe(1);
    }
  });

  test('a fresh instance agrees with a long-lived one', async () => {
    // No accumulated state: two instances must not disagree, or a run's
    // result would depend on how long the worker had been up.
    const other = new ScamTokenDetectionService();
    for (const [symbol, name] of CASES) {
      const at = new Date('2026-08-16T00:00:00Z');
      expect(other.calculateScamProbability(symbol, name, at)).toBe(
        detector.calculateScamProbability(symbol, name, at)
      );
    }
  });

  test('the source reaches for no clock, no randomness, no I/O', async () => {
    // The behavioural tests above cannot see a dependency that happens to be
    // stable while they run — a `process.env` read, or a repository call that
    // returns the same thing today. This one reads the source.
    const src = await Bun.file(SERVICE_SRC).text();
    // Strip the block comments; they discuss `new Date` and pricing lookups at
    // length, and a scan that trips on prose is a scan nobody keeps.
    const code = src.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const forbidden of [
      'Date.now',
      'new Date',
      'Math.random',
      'process.env',
      'Container.get',
      'await ',
      'Repository',
      'fetch(',
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });
});

describe('the version is a promise about the stored number', () => {
  test('every PERSISTED write of a scam score records where the score came from', async () => {
    // The defect this ticket is about is a stored score nobody can date, and
    // the near-miss found while fixing it is `markAsScam` — a human verdict
    // written into the same column, which a recompute would have silently
    // undone. A new persistence site that sets `isScamProbability` and says
    // nothing else would reintroduce one or the other, and nothing but this
    // would catch it.
    //
    // Only `.set({...})` / `.values({...})` count. `isScamProbability:` also
    // appears in select projections, DTO type literals and synthetic in-memory
    // tokens — an earlier version of this test flagged eight of those, which is
    // the noise that gets a guard deleted.
    const roots = [
      new URL('../../../src/', import.meta.url).pathname,
      new URL('../../../../../../apps/backend/api/src/', import.meta.url).pathname,
    ];
    const glob = new Bun.Glob('**/*.ts');
    const offenders: string[] = [];
    let compliant = 0;

    for (const root of roots) {
      for await (const rel of glob.scan(root)) {
        if (rel.includes('.test.')) continue;
        const src = await Bun.file(root + rel).text();
        const code = src.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        for (const m of code.matchAll(/\.(?:set|values)\(\{[^}]*\}/g)) {
          const payload = m[0];
          if (!payload.includes('isScamProbability')) continue;
          if (payload.includes('scamScoreVersion') || payload.includes('scamScoreSource')) {
            compliant += 1;
            continue;
          }
          offenders.push(`${rel}: ${payload.replace(/\s+/g, ' ').slice(0, 90)}`);
        }
      }
    }

    expect(offenders).toEqual([]);
    // A scan that matches nothing passes vacuously and protects nothing. There
    // are three such writes today — the repository's stamp and the two user
    // verdicts — so this pins the scan to something it can actually see.
    expect(compliant).toBeGreaterThanOrEqual(3);
  });

  test('the token-creation path stamps a version', async () => {
    // Not a `.set()`, so the scan above cannot see it: `TokenIdentityService`
    // builds an insert payload. A token born unstamped is stale on arrival and
    // would be handed to the recompute on its first night for no reason.
    const src = await Bun.file(
      new URL('../../../src/services/tokens/TokenIdentityService.ts', import.meta.url).pathname
    ).text();
    expect(src).toContain('scamScoreVersion');
  });

  test('the version is a positive integer', async () => {
    expect(Number.isInteger(SCAM_SCORE_VERSION)).toBe(true);
    expect(SCAM_SCORE_VERSION).toBeGreaterThan(0);
  });
});

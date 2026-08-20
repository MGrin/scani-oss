import { describe, expect, test } from 'bun:test';
import type { Token } from '@scani/db/schema';
import { Container } from 'typedi';
import { TokenRepository } from '../../../src/repositories/TokenRepository';
import {
  RescoreScamTokensService,
  type ScamScoreChange,
} from '../../../src/services/tokens/RescoreScamTokensService';
import {
  SCAM_SCORE_VERSION,
  ScamTokenDetectionService,
} from '../../../src/services/tokens/ScamTokenDetectionService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

/**
 * SC-286. The stored `is_scam_probability` was written once, at token
 * creation, and never recomputed — both call sites explicitly refuse a token
 * that already exists. So each improvement to the heuristic applied to tokens
 * created afterwards and to nothing else.
 *
 ***REMOVED***
 ***REMOVED***
 * surfaced it was `USCON` — "United States Covert Operations Network" — stored
 * at 0.80 because "Network" starts with "net", a real holding whose value was
 * being subtracted from the portfolio total.
 *
 * **The test that fails on the old behaviour is the first one below**: a token
 * whose stored score differs from what the current function returns has to be
 * REACHABLE. Before this change no code path could reach it at all — that was
 * the defect, not a symptom of it.
 */

function makeToken(over: Partial<Token> = {}): Token {
  return {
    id: 't-1',
    symbol: 'USCON',
    name: 'United States Covert Operations Network',
    typeId: 'type-crypto',
    decimals: 18,
    isScamProbability: 0.8,
    scamScoreVersion: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  } as unknown as Token;
}

interface StubState {
  stale: Token[];
  writes: Array<{ tokenId: string; score: number; version: number }>;
  askedVersion: number | null;
  askedLimit: number | null;
}

function makeService(stale: Token[]): { service: RescoreScamTokensService; state: StubState } {
  const state: StubState = { stale, writes: [], askedVersion: null, askedLimit: null };

  const repo = {
    async findWithStaleScamScore(version: number, limit: number): Promise<Token[]> {
      state.askedVersion = version;
      state.askedLimit = limit;
      return state.stale.slice(0, limit);
    },
    async applyScamScore(tokenId: string, score: number, version: number): Promise<void> {
      state.writes.push({ tokenId, score, version });
    },
  };

  // Stubbed-DI pattern (CLAUDE.md): seed the Container, then construct, so the
  // class-field initialisers read the stub. Never Container.reset().
  Container.set(TokenRepository, repo as unknown as TokenRepository);
  Container.set(ScamTokenDetectionService, new ScamTokenDetectionService());
  const service = new RescoreScamTokensService();
  Container.set(RescoreScamTokensService, service);
  return { service, state };
}

describe('a stored score that the current function would not produce is reachable', () => {
  test('THE INCIDENT: USCON at 0.80 is corrected to what the function returns', async () => {
    // The real row. Under the old behaviour nothing recomputed it, so it sat
    // above the 0.35 UI threshold and was subtracted from the portfolio total.
    const uscon = makeToken();
    const { service, state } = makeService([uscon]);

    // What the shipped function actually says about these two strings — read
    // from the function rather than hard-coded, so this test tracks the
    // heuristic instead of freezing a number beside it.
    const current = new ScamTokenDetectionService().calculateScamProbability(
      uscon.symbol,
      uscon.name,
      uscon.createdAt
    );
    expect(current).not.toBe(0.8);

    const result = await service.run();

    expect(result.examined).toBe(1);
    expect(result.changed).toHaveLength(1);
    const change = result.changed[0] as ScamScoreChange;
    expect(change.symbol).toBe('USCON');
    expect(change.from).toBe(0.8);
    expect(change.to).toBe(current);

    // ...and it was actually written, with the version alongside it.
    expect(state.writes).toEqual([{ tokenId: 't-1', score: current, version: SCAM_SCORE_VERSION }]);
  });

  test('a lowering is applied, not refused', async () => {
    // The tempting guard is "never lower a score". It would have kept USCON at
    // 0.80 forever. SC-207's regression was a change of INPUTS — the function
    // took `hasPriceData` — not recomputation; with the function pure in the
    // token's own characters a lowering is as trustworthy as a raising.
    const { service } = makeService([makeToken({ isScamProbability: 1 })]);
    const result = await service.run();
    expect(result.changed).toHaveLength(1);
    expect((result.changed[0] as ScamScoreChange).to).toBeLessThan(1);
  });

  test('a genuine scam is raised, not just lowered', async () => {
    // Asserted deliberately: a service that only ever lowered scores would
    // pass every test above while quietly disarming the detector.
    const { service } = makeService([
      makeToken({
        id: 't-scam',
        symbol: 'CLAIM',
        name: 'Visit claim-airdrop.xyz to claim your free reward',
        isScamProbability: 0,
      }),
    ]);
    const result = await service.run();
    expect(result.changed).toHaveLength(1);
    expect((result.changed[0] as ScamScoreChange).to).toBeGreaterThan(0.35);
  });
});

describe("a user's verdict is not a stale score", () => {
  test('the query, not the service, is what excludes it', async () => {
    // `markAsScam` / `unmarkAsScam` write a human decision into the same
    // column. The exclusion lives in `findWithStaleScamScore` — the service
    // recomputes whatever it is handed, so a row that reaches it IS meant to
    // be recomputed, and there is no second place for the rule to disagree
    // with itself.
    const repoSrc = await Bun.file(
      new URL('../../../src/repositories/TokenRepository.ts', import.meta.url).pathname
    ).text();
    const query = repoSrc.slice(
      repoSrc.indexOf('async findWithStaleScamScore('),
      repoSrc.indexOf('async applyScamScore(')
    );
    expect(query).toContain("scamScoreSource, 'heuristic'");
    // ...and crypto only, matching the creation gate: recomputing across all
    // types would be scam-scoring the S&P 500.
    expect(query).toContain("tokenTypes.code, 'crypto'");
    // `IS DISTINCT FROM`, because `<>` is NULL for a NULL left side — and the
    // NULL rows are the entire pre-existing population.
    expect(query).toContain('IS DISTINCT FROM');
  });
});

describe('what a run costs when nothing changed', () => {
  test('no stale rows means no writes at all', async () => {
    // The standing constraint is that operational cost must not increase.
    // On the ordinary run this is one indexed predicate that matches nothing:
    // no name reads, no writes, no `updated_at` churn.
    const { service, state } = makeService([]);
    const result = await service.run();
    expect(result).toEqual({ examined: 0, changed: [], more: false });
    expect(state.writes).toHaveLength(0);
  });

  test('it asks for exactly the current version', async () => {
    const { service, state } = makeService([]);
    await service.run();
    expect(state.askedVersion).toBe(SCAM_SCORE_VERSION);
  });

  test('a row that recomputes to the same number is still stamped', async () => {
    // Otherwise "nothing changed" leaves it unstamped, it comes back stale on
    // every future run, and the zero-cost quiet path becomes a permanent scan.
    const detector = new ScamTokenDetectionService();
    const settled = detector.calculateScamProbability(
      'USCON',
      'United States Covert Operations Network',
      new Date()
    );
    const { service, state } = makeService([makeToken({ isScamProbability: settled })]);

    const result = await service.run();
    expect(result.examined).toBe(1);
    expect(result.changed).toHaveLength(0);
    expect(state.writes).toEqual([{ tokenId: 't-1', score: settled, version: SCAM_SCORE_VERSION }]);
  });
});

describe('a version bump does not monopolise the worker', () => {
  test('a full page reports that more remains', async () => {
    // Bumping the version invalidates every crypto token at once. Saying
    // "there is more" is the difference between a run that finished and one
    // that got as far as it could — silence would read as the former.
    const many = Array.from({ length: 5 }, (_, i) => makeToken({ id: `t-${i}` }));
    const { service } = makeService(many);
    const result = await service.run(5);
    expect(result.examined).toBe(5);
    expect(result.more).toBe(true);
  });

  test('a partial page reports that it is done', async () => {
    const { service } = makeService([makeToken()]);
    const result = await service.run(5);
    expect(result.more).toBe(false);
  });
});

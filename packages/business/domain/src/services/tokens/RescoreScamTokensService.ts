import type { Token } from '@scani/db/schema';
import { Container, Service } from 'typedi';
import { TokenRepository } from '../../repositories/TokenRepository';
import { BaseService } from '../BaseService';
import { SCAM_SCORE_VERSION, ScamTokenDetectionService } from './ScamTokenDetectionService';

/**
 * Brings stored scam scores back in line with the function that produces them
 * (SC-286).
 *
 * ## The defect
 *
 * `is_scam_probability` was written once, at token creation, and never again —
 * both call sites explicitly refuse a token that already exists
 * (`SyncWalletBalancesUseCase` skips anything created before the run started;
 * `TokenIdentityService` only scores on the create path). So each improvement
 * to the heuristic applied to tokens created afterwards and to nothing else,
 * and the stored number quietly became a claim no shipped code would make.
 *
 * Measured in production: a small fraction of stored tokens held a score the
 * current function would not produce, several of them across the 0.35 UI
 * threshold. One was
 * `USCON` — "United States Covert Operations Network" — at 0.80, because
 * "Network" starts with "net". It was a real holding, and its value was being
 * subtracted from the portfolio total.
 *
 * ## Why a version column rather than "recompute everything nightly"
 *
 * Recomputing all rows every night gives the right answer and cannot say
 * anything about itself. A version column answers the question the incident
 * actually posed — *is this stored number current?* — per row, cheaply, and
 * without running the function. It also makes the operational cost of a
 * quiet period genuinely zero rather than merely small, which is the standing
 * constraint: one indexed predicate returning no rows, no reads of token
 * names, no writes, no `updated_at` churn, and nothing for the replication
 * stream to carry.
 *
 * The cost of the two together is one query per run when nothing changed.
 * The cost after a bump is exactly the rows that the bump invalidated, once.
 *
 * ## Crypto only, and why that is not an optimisation
 *
 * `TokenIdentityService` scores a token only when its type is `crypto`. So
 * every fiat and stock row holds a 0 that the function never produced —
 * the absence of a verdict, not a stale one. Recomputing across all types
 * would not be a backfill, it would be scam-scoring the S&P 500: measured
 * against production, `AMZN` / "AMAZON.COM INC" scores 0.50 (a literal dot,
 * a three-character TLD), `SPCX.TO` 0.50, `XUU` 0.20. The UI threshold is
 * 0.35 and `countsTowardTotal` is false at or above it, so the first run
 * would have badged Amazon a scam and subtracted a held blue chip from the
 * portfolio total — the same harm as `USCON`, caused by the fix for it.
 *
 * The rule is carried in two places that must agree: the type filter in
 * `findWithStaleScamScore`, and `scam_score_source`, which is `unscored`
 * for anything the function never ran on.
 *
 * ## Why there is no "only ever raise the score" guard
 *
 * The tempting guard — refuse to lower a score, on the grounds that SC-207
 * shipped a regression where scores fell — protects against the wrong thing.
 * SC-207 was a change of *inputs*: the function took `hasPriceData`, worth
 * 0.3, so a token's scam score dropped when our pricing coverage improved.
 * The recomputation was never the problem; scoring on a fact about us was.
 *
 * With the function pure in the token's own characters (see
 * `ScamTokenDetectionService`), a lowering is exactly as trustworthy as a
 * raising — both are the same function on the same two strings. A guard would
 * mean the stored value is no longer what the function returns, which is the
 * condition this service exists to end, and it would have kept `USCON` at
 * 0.80 forever.
 *
 * What replaces the guard is evidence: every change is logged with both
 * values, so a bad function version is visible in the run rather than
 * inferred from a portfolio total months later.
 */

export interface ScamScoreChange {
  tokenId: string;
  symbol: string;
  from: number;
  to: number;
}

export interface RescoreResult {
  /** Rows whose version was not current — the work the run found. */
  examined: number;
  /** Of those, the ones whose score actually moved. */
  changed: ScamScoreChange[];
  /**
   * True when the page came back full, so more stale rows remain. The next
   * fire picks them up; nothing is lost, and a single run cannot monopolise
   * the worker after a version bump invalidates every row at once.
   */
  more: boolean;
}

/**
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 * memecoins.
 */
export const RESCORE_BATCH_SIZE = 500;

@Service()
export class RescoreScamTokensService extends BaseService {
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly scamDetectionService = Container.get(ScamTokenDetectionService);

  constructor() {
    super('RescoreScamTokensService');
  }

  async run(batchSize: number = RESCORE_BATCH_SIZE): Promise<RescoreResult> {
    const stale = await this.tokenRepository.findWithStaleScamScore(SCAM_SCORE_VERSION, batchSize);

    if (stale.length === 0) {
      // The quiet path, and the one that runs on almost every fire: a single
      // indexed predicate that matched nothing. Logged at debug so a healthy
      // run is observable without writing a line an hour forever.
      this.logDebug('No tokens with a stale scam score', { version: SCAM_SCORE_VERSION });
      return { examined: 0, changed: [], more: false };
    }

    const changed: ScamScoreChange[] = [];
    for (const token of stale) {
      const score = this.recompute(token);
      // The version is stamped whether or not the score moved. A row that
      // recomputes to the same number IS current — leaving it unstamped
      // because "nothing changed" would hand it back on every future run and
      // turn the zero-cost quiet path into a permanent scan.
      await this.tokenRepository.applyScamScore(token.id, score, SCAM_SCORE_VERSION);

      if (score !== token.isScamProbability) {
        changed.push({
          tokenId: token.id,
          symbol: token.symbol,
          from: token.isScamProbability,
          to: score,
        });
      }
    }

    // Both values for every change, because the alternative to this evidence
    // is discovering a bad version the way this ticket's defect was
    // discovered — from a wrong portfolio total.
    if (changed.length > 0) {
      this.logInfo('Scam scores recomputed', {
        version: SCAM_SCORE_VERSION,
        examined: stale.length,
        changed: changed.length,
        changes: changed,
      });
    }

    return { examined: stale.length, changed, more: stale.length === batchSize };
  }

  private recompute(token: Token): number {
    return this.scamDetectionService.calculateScamProbability(
      token.symbol,
      token.name,
      token.createdAt
    );
  }
}

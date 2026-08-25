import { Service } from 'typedi';
import { BaseService } from '../BaseService';
import { normalizeForDetection } from './token-identity-safety';

/**
 * Which revision of `calculateScamProbability` the stored score came from.
 *
 * **Bump this in the same commit as any change to the function's output.**
 * That is the entire contract: the number is meaningless as a version of the
 * file, and load-bearing as an answer to "would the current function still
 * produce what is stored?".
 *
 * The score is written once, at token creation, and both call sites refuse to
 * touch a token that already exists — so before SC-286 every improvement to
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 * "Network" begins with "net", and it was a real holding being subtracted from
 * the portfolio total.
 *
 * Version 1 is the function as of SC-207 — the revision that dropped the
 * `hasPriceData` input. It is deliberately NOT backdated onto existing rows:
 * a row scored before this column existed carries NULL, which means "unknown,
 * therefore stale", not "version 1".
 *
 * Version 2 is SC-281: the content checks below judge
 * `normalizeForDetection(text)` instead of the raw string, so an entity-encoded
 * or confusable separator is seen. This bump invalidates every crypto row and
 * `RescoreScamTokensService` will re-examine all of them on its next fire —
 * which is the designed cost of a bump, paid once. Only names carrying an
 * entity or a confusable can actually move: normalization is the identity
 * function on plain ASCII, so the other rows recompute to what they already
 * hold and are simply restamped.
 */
export const SCAM_SCORE_VERSION = 2;

/**
 * Service for detecting scam crypto tokens based on various heuristics
 *
 * Scam detection is only applicable to crypto tokens, not stocks, fiat, or other types
 */
@Service()
export class ScamTokenDetectionService extends BaseService {
  // Suspicious words that often appear in scam token names/symbols
  private readonly SUSPICIOUS_WORDS = new Set([
    'visit',
    'claim',
    'airdrop',
    'bonus',
    'reward',
    'free',
    'giveaway',
    'moon',
    'safe',
    'elon',
    'winner',
    'prize',
    'gift',
    'redeem',
    'voucher',
    'swap',
    'ponzi',
    'fomo',
    'invited',
    'participate',
  ]);

  /**
   * A URL needs a DOT, not a space (SC-275).
   *
   * This used to accept `[\s˳.]` before each TLD, so a space followed by
   ***REMOVED***
   * token names in production, that scored **`LooksRare Token`,
   * `Liquid Staking Token`, `BullRun Meme` and `Base Lotto` at 0.80** — over
   * the 0.35 gate, so excluded from every portfolio total, the holdings total
   * and the historical chart. The word "Token" was enough.
   *
   * Every genuine URL-shaped name in that corpus uses a real dot —
   * `Aintiution.io`, `Draf.io`, `EthFork2.com`, `@ MetaWin.to`,
   * `#HEXPool.net`, `yield-farming.io` — so requiring one loses no true
   * positive. The trailing boundary stops `.token` matching as `.to`.
   */
  private readonly URL_PATTERN =
    /(?:https?:\/\/|www\.|[˳.](?:com|net|org|io|xyz|app|gg|me|to|pm|fun)(?![a-z0-9]))/i;

  /**
   * A glued domain — `GIVEAWAYSCOM`, `GIVEAWAYS˳COM` — after separators are
   * stripped. **Three-character TLDs and longer only** (SC-275).
   *
   * It used to include the two-character ones, and since this rule ignores
   * separators entirely, "ends in -to" or "-me" was enough: in production
   * that scored `Base Lotto`, `Slop Sato` and `BullRun Meme` at 0.80 and
   * excluded them from every total. Ordinary words end in `to` and `me`;
   ***REMOVED***
   ***REMOVED***
   ***REMOVED***
   *
   * The short TLDs are not lost — `URL_PATTERN` still catches them when a
   * real dot is present, which is how `Draf.io` and `@ MetaWin.to` are
   * caught. What goes is only the separator-less guess.
   */
  private readonly TLD_PATTERN = /^.{4,}(?:com|net|org|xyz|app|fun)$/i;

  // Emoji pattern regex (simplified - matches common emoji ranges)
  private readonly EMOJI_PATTERN =
    /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;

  // Homoglyph pattern: a Unicode LETTER that is not ASCII. Exchange/chain
  // tickers are ASCII, so a non-ASCII letter in a symbol means a lookalike
  // impersonation (Cyrillic Ѕ/С/Т, Lisu ꓴꓢꓓ, Greek, fullwidth Latin, …).
  // Scoped to letters so it doesn't overlap the emoji check.
  private readonly HOMOGLYPH_PATTERN = /(?!\p{ASCII})\p{L}/u;

  constructor() {
    super('ScamTokenDetectionService');
  }

  /**
   * Calculate scam probability for a crypto token
   *
   * @param symbol - Token symbol
   * @param name - Token name
   * @param createdAt - Token creation date
   * @returns Probability score between 0 (not scam) and 1 (likely scam)
   *
   * **A function of the token's own characters, and nothing else (SC-207).**
   * It took a `hasPriceData` argument worth 0.3, which is a fact about OUR
   * coverage that the token has no part in, and the parameter is removed
   * rather than defaulted so every caller had to be revisited — a default
   * would have left the two write-back sites compiling unchanged.
   *
   * What that 0.3 cost, measured before removing it: a homoglyph scores 0.7,
   * `TokenIdentityService` always scores with no price data, and its gate
   * refuses at 0.95 — so 0.7 + 0.3 = 1.00 and **every newly-arriving
   * lookalike token was refused**, while the file's own comment said "A
   * LOOKALIKE SYMBOL IS NOT REJECTED HERE" and SC-197 shipped a UI for
   * marking them. At 0.7 alone the row is created and marked, which is the
   * design that was intended.
   */
  calculateScamProbability(symbol: string, name: string, _createdAt: Date): number {
    let probability = 0;
    const reasons: string[] = [];

    // CONTENT checks read the normalized text; CHARACTER-CLASS checks read the
    // original (SC-281). `yield-farming&period;io` is a host and must score as
    // one, but `UЅDС` normalizes to `USDC` and a homoglyph check handed that
    // would report a clean ASCII ticker — deleting the 0.70 signal that is the
    // whole reason the check exists. The split is the fix; applying
    // normalization uniformly would be a regression wearing its clothes.
    const detectableSymbol = normalizeForDetection(symbol);
    const detectableName = normalizeForDetection(name);

    // Check 1: URL in symbol or name (very strong indicator)
    const hasUrl = this.hasUrl(detectableSymbol) || this.hasUrl(detectableName);
    const hasTld = this.hasTldPattern(detectableSymbol) || this.hasTldPattern(detectableName);
    if (hasUrl || hasTld) {
      probability += 0.5;
      reasons.push('Contains URL or domain pattern');
    }

    // Check 2: Suspicious words in name or symbol
    const hasSuspicious =
      this.hasSuspiciousWords(detectableSymbol) || this.hasSuspiciousWords(detectableName);
    if (hasSuspicious) {
      probability += 0.4;
      reasons.push('Contains suspicious words (visit, claim, etc.)');
    }

    // Check 2.5: Compound scam pattern (suspicious word + URL/TLD)
    if (hasSuspicious && (hasUrl || hasTld)) {
      probability += 0.3; // Extra penalty for combining scam indicators
      reasons.push('Multiple scam indicators combined');
    }

    // Check 3: Too long name with multiple words
    if (this.hasExcessivelyLongName(name)) {
      probability += 0.2;
      reasons.push('Excessively long name');
    }

    // Check 4: Emoji in name or symbol
    if (this.hasEmoji(symbol) || this.hasEmoji(name)) {
      probability += 0.2;
      reasons.push('Contains emoji');
    }

    // Check 4.5: Homoglyph symbol (non-ASCII lookalike letters). Very strong
    // on its own — legitimate tickers never carry these. Weighted above the
    // threshold so a fresh impersonation is flagged without other signals.
    if (this.hasHomoglyph(symbol)) {
      probability += 0.7;
      reasons.push('Symbol uses non-ASCII lookalike (homoglyph) letters');
    }

    // Check 5: Common symbol but created recently — DISABLED
    // This check measures when our system created the token record, not the
    // token's actual blockchain age. Since every import creates tokens "now",
    // legitimate tokens like ETH/USDC always trigger this, causing false
    // positives. Real scam tokens are caught by URL/name pattern checks above.

    // Check 6 — REMOVED (SC-207). It awarded 0.3 for "No pricing data
    // available", which measures our coverage rather than the token, and it
    // was written back: `PriceWarmupService` re-scored priced
    // tokens and persisted the lower number, so a token's scam score fell
    // when our pricing improved. Every token was created at ≥0.3 and drifted
    // to its true score later, which made the number un-comparable across
    // time and across machines.
    //
    // It also decided admissions it had no business deciding — see the note
    // on `calculateScamProbability` for the lookalike case it broke.

    // Cap probability at 1.0
    probability = Math.min(probability, 1.0);

    if (probability > 0.5) {
      this.logDebug('High scam probability detected', {
        symbol,
        name,
        probability: probability.toFixed(2),
        reasons,
      });
    }

    return probability;
  }

  /**
   * Check if text contains URL patterns
   */
  private hasUrl(text: string): boolean {
    return this.URL_PATTERN.test(text);
  }

  /**
   * Check if text ends with or contains TLD-like patterns
   * Catches things like "GIVEAWAYSCOM" or "SOMETHING˳COM"
   */
  private hasTldPattern(text: string): boolean {
    // Remove spaces and special unicode characters, then check if ends with TLD
    const normalized = text.replace(/[\s˳._-]/g, '').toLowerCase();
    return this.TLD_PATTERN.test(normalized);
  }

  /**
   * Check if text contains suspicious words
   */
  private hasSuspiciousWords(text: string): boolean {
    const lowerText = text.toLowerCase();
    return Array.from(this.SUSPICIOUS_WORDS).some((word) => lowerText.includes(word));
  }

  /**
   * Check if name is excessively long (more than 5 words or more than 50 characters)
   */
  private hasExcessivelyLongName(name: string): boolean {
    const wordCount = name.trim().split(/\s+/).length;
    return wordCount > 5 || name.length > 50;
  }

  /**
   * Check if text contains emoji
   */
  private hasEmoji(text: string): boolean {
    return this.EMOJI_PATTERN.test(text);
  }

  /**
   * Check if a symbol contains non-ASCII lookalike (homoglyph) letters used
   * to impersonate a legitimate ticker (e.g. Cyrillic Ѕ/С/Т in "UЅDС").
   */
  private hasHomoglyph(symbol: string): boolean {
    return this.HOMOGLYPH_PATTERN.test(symbol);
  }

  /**
   * Batch calculate scam probabilities for multiple tokens
   */
  async calculateBatchScamProbabilities(
    tokens: Array<{
      symbol: string;
      name: string;
      createdAt: Date;
    }>
  ): Promise<Map<string, number>> {
    const results = new Map<string, number>();

    for (const token of tokens) {
      const probability = this.calculateScamProbability(token.symbol, token.name, token.createdAt);
      results.set(`${token.symbol}-${token.name}`, probability);
    }

    this.logInfo('Batch scam detection completed', {
      totalTokens: tokens.length,
      highRiskCount: Array.from(results.values()).filter((p) => p > 0.7).length,
    });

    return results;
  }

  /**
   * Get recommended threshold for filtering scam tokens
   * Returns probability above which tokens should be hidden
   */
  getRecommendedThreshold(): number {
    return 0.45;
  }

  /**
   * Check if a token should be filtered based on scam probability
   */
  shouldFilterToken(scamProbability: number): boolean {
    return scamProbability > this.getRecommendedThreshold();
  }
}

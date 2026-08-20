import { describe, expect, it } from 'bun:test';
import { SCAM_PROBABILITY_THRESHOLD } from '../../../src/lib/constants';
import { ScamTokenDetectionService } from '../../../src/services/tokens/ScamTokenDetectionService';

const service = new ScamTokenDetectionService();
const recentDate = new Date();
const oldDate = new Date('2020-01-01');

describe('ScamTokenDetectionService', () => {
  describe('calculateScamProbability', () => {
    it('should give low probability to legitimate tokens with price data', () => {
      const prob = service.calculateScamProbability('ETH', 'Ethereum', oldDate);
      expect(prob).toBeLessThan(0.3);
    });

    it('should give high probability to tokens with URLs in name', () => {
      const prob = service.calculateScamProbability(
        'SCAM',
        'Visit https://scam.com to claim',
        recentDate
      );
      expect(prob).toBeGreaterThan(0.7);
    });

    it('should give high probability to tokens with .com/.io domains', () => {
      const prob = service.calculateScamProbability('FREEBTC.IO', 'Free Bitcoin IO', recentDate);
      expect(prob).toBeGreaterThan(0.5);
    });

    it('should flag tokens with suspicious words', () => {
      const prob = service.calculateScamProbability('CLAIM', 'Claim Free Airdrop', recentDate);
      // Was `> 0.5` only because an unpriced token carried +0.30 (SC-207).
      // The meaningful property is that it clears the filter threshold on
      // the strength of its own name.
      expect(prob).toBeGreaterThanOrEqual(SCAM_PROBABILITY_THRESHOLD);
    });

    it('should flag tokens with emojis', () => {
      const prob = service.calculateScamProbability('🚀MOON', 'Rocket Moon Token', recentDate);
      expect(prob).toBeGreaterThan(0.3);
    });

    it('should flag excessively long names', () => {
      const prob = service.calculateScamProbability(
        'LONG',
        'This is an incredibly long token name that no legitimate project would ever use for their cryptocurrency',
        oldDate
      );
      // 0.2 on its own, and BELOW the 0.35 gate — an over-long name is a
      // hint, not a verdict. It was only ever over the line because every
      // unpriced token also carried +0.3 (SC-207).
      expect(prob).toBeCloseTo(0.2, 10);
      expect(prob).toBeLessThan(SCAM_PROBABILITY_THRESHOLD);
    });

    it('should not flag common symbol just because it was created recently', () => {
      // "Recently created" is measured by our system's token creation time,
      // not the actual blockchain age. Legitimate imports always create tokens
      // "now", so this signal only produces false positives.
      const prob = service.calculateScamProbability('BTC', 'Bitcoin', recentDate);
      expect(prob).toBeLessThan(0.35); // Only "no pricing data" contributes
    });

    it('should score zero for common symbol with price data', () => {
      const prob = service.calculateScamProbability('BTC', 'Bitcoin', oldDate);
      expect(prob).toBe(0);
    });

    it('should cap probability at 1.0', () => {
      const prob = service.calculateScamProbability(
        'VISIT-SCAM.COM',
        'Visit https://scam.com claim free airdrop giveaway bonus 🚀🚀🚀',
        recentDate
      );
      expect(prob).toBeLessThanOrEqual(1.0);
    });

    it('should give 0 probability to clean tokens with all indicators positive', () => {
      const prob = service.calculateScamProbability('MATIC', 'Polygon', oldDate);
      expect(prob).toBe(0);
    });

    it('an unknown token is not suspected merely for being unknown', () => {
      // Replaces 'should increase probability when no price data available',
      // which asserted the behaviour SC-207 removed. That old test only
      // compared its two calls to each other, so it never showed what either
      // one WAS — and what it was, was 0.50: `URL_PATTERN` read the space
      // before the word "Token" as a domain. Both halves are fixed now
      // (SC-207, SC-275), and this is the assertion that shows it.
      expect(service.calculateScamProbability('UNKNOWN', 'Unknown Token', oldDate)).toBe(0);
      expect(service.calculateScamProbability('UNKNOWN', 'Unknown', oldDate)).toBe(0);
    });

    it('should not flag short legitimate symbols that happen to match TLDs', () => {
      // Tokens like ME, IO, FUN, JTO, BIO are legitimate despite matching TLD suffixes
      for (const [symbol, name] of [
        ['ME', 'Magic Eden'],
        ['IO', 'IO'],
        ['FUN', 'FunFair'],
        ['JTO', 'Jito'],
        ['BIO', 'BIO'],
      ] as const) {
        const prob = service.calculateScamProbability(symbol, name, oldDate);
        expect(prob).toBe(0);
      }
    });

    it('should still flag obfuscated domains like GIVEAWAYSCOM', () => {
      // The separator-less case `hasTldPattern` exists for, and the reason
      // SC-275 narrowed that rule to 3+ character TLDs rather than gating it
      // on a separator being present: this has none.
      const prob = service.calculateScamProbability('GIVEAWAYSCOM', 'Giveaways Com', recentDate);
      expect(prob).toBeGreaterThanOrEqual(SCAM_PROBABILITY_THRESHOLD);
    });

    it('should flag homoglyph symbols using non-Latin lookalike letters', () => {
      // Real-world phishing tokens seen in prod: Cyrillic Ѕ/С/Т and Lisu ꓴꓢꓓ
      // used to impersonate USDC/USDT/ETH. Crypto tickers are ASCII, so any
      // non-ASCII letter in the symbol is a strong impersonation signal.
      for (const [symbol, name] of [
        ['UЅDС', 'USDC'], // UЅDС (Cyrillic Ѕ, С)
        ['UЅDТ', 'USDT'], // UЅDТ (Cyrillic Ѕ, Т)
        ['EТH', 'ETH'], // EТH (Cyrillic Т)
        ['ꓴꓢꓓС', 'USDC'], // ꓴꓢꓓС (Lisu + Cyrillic)
      ] as const) {
        const prob = service.calculateScamProbability(symbol, name, recentDate);
        expect(prob).toBeGreaterThan(0.35);
      }
    });

    it('should flag homoglyph symbols even when price data is claimed', () => {
      // The homoglyph signal is symbol-intrinsic and must not be masked by a
      // (spoofed) price-data flag.
      const prob = service.calculateScamProbability('UЅDС', 'USDC', oldDate);
      expect(prob).toBeGreaterThan(0.35);
    });

    it('should not flag legitimate ASCII symbols as homoglyphs', () => {
      for (const [symbol, name] of [
        ['USDC', 'USD Coin'],
        ['ETH', 'Ethereum'],
        ['WETH', 'Wrapped Ether'],
      ] as const) {
        const prob = service.calculateScamProbability(symbol, name, oldDate);
        expect(prob).toBe(0);
      }
    });

    /**
     * SC-207. The two tests that stood here pinned a "no pricing data"
     * weight of 0.30 and the feedback loop it created. Both are gone with
     * the signal, and what replaces them is the invariant that made it
     * removable: **the score is a function of the token's characters and
     * nothing else**, so it cannot move when our coverage moves.
     *
     * What the weight cost, measured before removing it:
     *
     *   - A homoglyph scores 0.70. `TokenIdentityService` always scores with
     *     no price data and refuses at 0.95, so 0.70 + 0.30 = 1.00 and every
     *     newly-arriving lookalike token was REFUSED — while that file's own
     *     comment said "A LOOKALIKE SYMBOL IS NOT REJECTED HERE" and SC-197
     *     shipped a column and a UI for marking them. Verified end to end
     *     against the real service, unstubbed, in both directions.
     *   - The loop the old test described: the threshold gates
     *     `HoldingRepository.getDistinctTokenIds`, which chooses what the
     *     hourly pricing job asks about. A token pushed over the line by the
     *     0.30 was not asked about, so it stayed unpriced, so it kept the
     *     0.30. A score that is an input to the job that would change the
     *     score cannot settle. Removing the term removes the loop.
     */
    it('the score does not move when our pricing coverage does', () => {
      // The property the whole ticket is about: two calls, one token, no
      // argument left that could make them differ.
      for (const [symbol, name] of [
        ['USDC', 'USD Coin'],
        ['ETH', 'Ethereum'],
        ['AAVE', 'Aave'],
        ['UЅDС', 'USD Coin'],
      ] as const) {
        const score = service.calculateScamProbability(symbol, name, oldDate);
        expect(service.calculateScamProbability(symbol, name, new Date()), `${symbol}`).toBe(score);
      }
    });

    it('an ordinary token scores zero rather than 0.30 for being new', () => {
      // Every token used to be created at ≥0.30 and drift down later, which
      // made the number un-comparable across time and across machines.
      for (const [symbol, name] of [
        ['USDC', 'USD Coin'],
        ['ETH', 'Ethereum'],
        ['USDT', 'Tether'],
      ] as const) {
        expect(service.calculateScamProbability(symbol, name, oldDate), symbol).toBe(0);
      }
    });

    /**
     * The case the removal exists for. A homoglyph must stay BELOW the 0.95
     * creation gate so the row is created and marked (SC-197), and ABOVE the
     * 0.35 inclusion threshold so it never counts toward a total.
     */
    it('a homoglyph is admitted for marking but never included in a total', () => {
      const score = service.calculateScamProbability('UЅDС', 'USD Coin', oldDate);

      expect(score).toBeCloseTo(0.7, 10);
      expect(score).toBeLessThan(0.95);
      expect(score).toBeGreaterThanOrEqual(SCAM_PROBABILITY_THRESHOLD);
    });

    /**
     * SC-275, and the fixtures are REAL — every name below was read from the
     * 371 rows in the production `tokens` table, not invented. The ticket's
     * original evidence was the pattern applied to hypothetical names
     * (`Curve DAO Token`, `Uniswap`), none of which exist there, and that
     * nearly reached mgrin as "your portfolio is missing Chainlink".
     *
     * `URL_PATTERN` accepted `[\s˳.]` before each TLD, so a space followed by
     * `to`/`me`/`net` read as a domain; `hasTldPattern` stripped separators
     * and matched any name merely ENDING in a short TLD. Between them these
     * five scored 0.80 — over the 0.35 gate, so excluded from every portfolio
     * total, the holdings total and the historical chart.
     */
    it.each([
      ['LOOKS', 'LooksRare Token'],
      ['LST', 'Liquid Staking Token'],
      ['BRM', 'BullRun Meme'],
      ['BLOTTO', 'Base Lotto'],
      ['SATO', 'Slop Sato'],
    ])('%s (%s) is not a URL and counts toward totals', (symbol, name) => {
      expect(service.calculateScamProbability(symbol, name, oldDate)).toBeLessThan(
        SCAM_PROBABILITY_THRESHOLD
      );
    });

    /**
     * The other half of the same change: every genuinely URL-shaped name in
     * that corpus uses a real dot, so requiring one loses no true positive.
     * Measured across all 371: 25 rows score at/above the gate afterwards and
     * none of them is a false positive of this kind.
     */
    it.each([
      ['AI', 'Aintiution.io'],
      ['DRAF.IO', 'Draf.io'],
      ['ETHFORK2.COM', 'EthFork2.com'],
      ['RAFFLE TICKET', '@ MetaWin.to'],
      ['WHEX', '#HEXPool.net'],
      ['YIELDX', 'yield-farming.io'],
    ])('%s (%s) is still caught', (symbol, name) => {
      expect(service.calculateScamProbability(symbol, name, oldDate)).toBeGreaterThanOrEqual(
        SCAM_PROBABILITY_THRESHOLD
      );
    });

    it('a glued domain with the homoglyph dot is still caught', () => {
      expect(
        service.calculateScamProbability('GIVEAWAYS˳COM', 'Giveaways˳com', oldDate)
      ).toBeGreaterThanOrEqual(SCAM_PROBABILITY_THRESHOLD);
    });

    it('a dot inside a word is not a domain', () => {
      // `.to` followed by a letter is `.token`, not Tonga.
      expect(service.calculateScamProbability('WRAP', 'wrapped.token', oldDate)).toBe(0);
    });

    it('should compound URL + suspicious word penalties', () => {
      const urlOnly = service.calculateScamProbability('TOKEN.COM', 'Token Com', oldDate);
      const urlAndSuspicious = service.calculateScamProbability(
        'CLAIM.COM',
        'Claim Token Com',
        oldDate
      );
      expect(urlAndSuspicious).toBeGreaterThan(urlOnly);
    });
  });
});

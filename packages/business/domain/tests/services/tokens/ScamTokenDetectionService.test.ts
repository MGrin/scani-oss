import { describe, expect, it } from 'bun:test';
import { ScamTokenDetectionService } from '../../../src/services/tokens/ScamTokenDetectionService';

const service = new ScamTokenDetectionService();
const recentDate = new Date();
const oldDate = new Date('2020-01-01');

describe('ScamTokenDetectionService', () => {
  describe('calculateScamProbability', () => {
    it('should give low probability to legitimate tokens with price data', () => {
      const prob = service.calculateScamProbability('ETH', 'Ethereum', oldDate, true);
      expect(prob).toBeLessThan(0.3);
    });

    it('should give high probability to tokens with URLs in name', () => {
      const prob = service.calculateScamProbability(
        'SCAM',
        'Visit https://scam.com to claim',
        recentDate,
        false
      );
      expect(prob).toBeGreaterThan(0.7);
    });

    it('should give high probability to tokens with .com/.io domains', () => {
      const prob = service.calculateScamProbability(
        'FREEBTC.IO',
        'Free Bitcoin IO',
        recentDate,
        false
      );
      expect(prob).toBeGreaterThan(0.5);
    });

    it('should flag tokens with suspicious words', () => {
      const prob = service.calculateScamProbability(
        'CLAIM',
        'Claim Free Airdrop',
        recentDate,
        false
      );
      expect(prob).toBeGreaterThan(0.5);
    });

    it('should flag tokens with emojis', () => {
      const prob = service.calculateScamProbability(
        '🚀MOON',
        'Rocket Moon Token',
        recentDate,
        false
      );
      expect(prob).toBeGreaterThan(0.3);
    });

    it('should flag excessively long names', () => {
      const prob = service.calculateScamProbability(
        'LONG',
        'This is an incredibly long token name that no legitimate project would ever use for their cryptocurrency',
        oldDate,
        false
      );
      expect(prob).toBeGreaterThan(0.3);
    });

    it('should not flag common symbol just because it was created recently', () => {
      // "Recently created" is measured by our system's token creation time,
      // not the actual blockchain age. Legitimate imports always create tokens
      // "now", so this signal only produces false positives.
      const prob = service.calculateScamProbability('BTC', 'Bitcoin', recentDate, false);
      expect(prob).toBeLessThan(0.35); // Only "no pricing data" contributes
    });

    it('should score zero for common symbol with price data', () => {
      const prob = service.calculateScamProbability('BTC', 'Bitcoin', oldDate, true);
      expect(prob).toBe(0);
    });

    it('should cap probability at 1.0', () => {
      const prob = service.calculateScamProbability(
        'VISIT-SCAM.COM',
        'Visit https://scam.com claim free airdrop giveaway bonus 🚀🚀🚀',
        recentDate,
        false
      );
      expect(prob).toBeLessThanOrEqual(1.0);
    });

    it('should give 0 probability to clean tokens with all indicators positive', () => {
      const prob = service.calculateScamProbability('MATIC', 'Polygon', oldDate, true);
      expect(prob).toBe(0);
    });

    it('should increase probability when no price data available', () => {
      const withPrice = service.calculateScamProbability('UNKNOWN', 'Unknown Token', oldDate, true);
      const withoutPrice = service.calculateScamProbability(
        'UNKNOWN',
        'Unknown Token',
        oldDate,
        false
      );
      expect(withoutPrice).toBeGreaterThan(withPrice);
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
        const prob = service.calculateScamProbability(symbol, name, oldDate, true);
        expect(prob).toBe(0);
      }
    });

    it('should still flag obfuscated domains like GIVEAWAYSCOM', () => {
      const prob = service.calculateScamProbability(
        'GIVEAWAYSCOM',
        'Giveaways Com',
        recentDate,
        false
      );
      expect(prob).toBeGreaterThan(0.5);
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
        const prob = service.calculateScamProbability(symbol, name, recentDate, false);
        expect(prob).toBeGreaterThan(0.35);
      }
    });

    it('should flag homoglyph symbols even when price data is claimed', () => {
      // The homoglyph signal is symbol-intrinsic and must not be masked by a
      // (spoofed) price-data flag.
      const prob = service.calculateScamProbability('UЅDС', 'USDC', oldDate, true);
      expect(prob).toBeGreaterThan(0.35);
    });

    it('should not flag legitimate ASCII symbols as homoglyphs', () => {
      for (const [symbol, name] of [
        ['USDC', 'USD Coin'],
        ['ETH', 'Ethereum'],
        ['WETH', 'Wrapped Ether'],
      ] as const) {
        const prob = service.calculateScamProbability(symbol, name, oldDate, true);
        expect(prob).toBe(0);
      }
    });

    it('should compound URL + suspicious word penalties', () => {
      const urlOnly = service.calculateScamProbability('TOKEN.COM', 'Token Com', oldDate, true);
      const urlAndSuspicious = service.calculateScamProbability(
        'CLAIM.COM',
        'Claim Token Com',
        oldDate,
        true
      );
      expect(urlAndSuspicious).toBeGreaterThan(urlOnly);
    });
  });
});

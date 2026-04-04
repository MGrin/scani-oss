import { describe, expect, it } from 'bun:test';
import { ScamTokenDetectionService } from './ScamTokenDetectionService';

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

    it('should flag common symbol created recently', () => {
      const prob = service.calculateScamProbability('BTC', 'Bitcoin', recentDate, false);
      expect(prob).toBeGreaterThan(0.5);
    });

    it('should NOT flag common symbol created long ago with price data', () => {
      const prob = service.calculateScamProbability('BTC', 'Bitcoin', oldDate, true);
      expect(prob).toBeLessThan(0.3);
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

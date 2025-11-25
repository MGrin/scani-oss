import { Service } from 'typedi';
import { BaseService } from './BaseService';

/**
 * Service for detecting scam crypto tokens based on various heuristics
 *
 * Scam detection is only applicable to crypto tokens, not stocks, fiat, or other types
 */
@Service()
export class ScamTokenDetectionService extends BaseService {
  // Common legitimate token symbols that scammers often mimic
  private readonly COMMON_TOKEN_SYMBOLS = new Set([
    'BTC',
    'ETH',
    'USDT',
    'USDC',
    'BNB',
    'SOL',
    'ADA',
    'DOGE',
    'MATIC',
    'DOT',
    'SHIB',
    'AVAX',
    'TRX',
    'UNI',
    'LINK',
    'XRP',
    'LTC',
    'ETC',
    'BCH',
    'XLM',
    'ATOM',
    'FIL',
    'APT',
    'NEAR',
  ]);

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

  // URL pattern regex
  private readonly URL_PATTERN =
    /(?:https?:\/\/|www\.|\.com|\.io|\.net|\.org|\.xyz|\.app|\.gg|\.me)/i;

  // Emoji pattern regex (simplified - matches common emoji ranges)
  private readonly EMOJI_PATTERN =
    /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;

  // Creation date threshold (tokens claiming to be well-known but created recently)
  private readonly RECENT_TOKEN_THRESHOLD_MONTHS = 24;

  constructor() {
    super('ScamTokenDetectionService');
  }

  /**
   * Calculate scam probability for a crypto token
   *
   * @param symbol - Token symbol
   * @param name - Token name
   * @param createdAt - Token creation date
   * @param hasPriceData - Whether the token has pricing data from reliable sources
   * @returns Probability score between 0 (not scam) and 1 (likely scam)
   */
  calculateScamProbability(
    symbol: string,
    name: string,
    createdAt: Date,
    hasPriceData: boolean = false
  ): number {
    let probability = 0;
    const reasons: string[] = [];

    // Check 1: URL in symbol or name (very strong indicator)
    if (this.hasUrl(symbol) || this.hasUrl(name)) {
      probability += 0.5; // Increased from 0.4
      reasons.push('Contains URL');
    }

    // Check 2: Suspicious words in name or symbol
    if (this.hasSuspiciousWords(symbol) || this.hasSuspiciousWords(name)) {
      probability += 0.4; // Increased from 0.3
      reasons.push('Contains suspicious words (visit, claim, etc.)');
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

    // Check 5: Common symbol but created recently
    if (this.isRecentCommonSymbol(symbol, createdAt)) {
      probability += 0.3;
      reasons.push('Common symbol but recently created');
    }

    // Check 6: No pricing data from reliable sources (strong indicator)
    if (!hasPriceData) {
      probability += 0.4;
      reasons.push('No pricing data available');
    }

    // Cap probability at 1.0
    probability = Math.min(probability, 1.0);

    if (probability > 0.5) {
      this.logInfo('High scam probability detected', {
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
   * Check if token has a common symbol but was created recently
   * (scammers often create fake versions of popular tokens)
   */
  private isRecentCommonSymbol(symbol: string, createdAt: Date): boolean {
    if (!this.COMMON_TOKEN_SYMBOLS.has(symbol.toUpperCase())) {
      return false;
    }

    const monthsAgo = this.RECENT_TOKEN_THRESHOLD_MONTHS;
    const threshold = new Date();
    threshold.setMonth(threshold.getMonth() - monthsAgo);

    return createdAt > threshold;
  }

  /**
   * Batch calculate scam probabilities for multiple tokens
   */
  async calculateBatchScamProbabilities(
    tokens: Array<{
      symbol: string;
      name: string;
      createdAt: Date;
      hasPriceData?: boolean;
    }>
  ): Promise<Map<string, number>> {
    const results = new Map<string, number>();

    for (const token of tokens) {
      const probability = this.calculateScamProbability(
        token.symbol,
        token.name,
        token.createdAt,
        token.hasPriceData ?? false
      );
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

/**
 * Heuristics that flag a token as likely spam/scam. EVM token-discovery
 * is by-design unlimited (anyone can deploy a contract and airdrop it
 * to your wallet), so a wallet's `tokentx` history routinely contains
 * dozens of phishing/airdrop garbage. We reject those before the
 * federated identity flow ever sees them.
 *
 * Pre-refactor location: inline in
 * `packages/integrations/src/blockchain-services/evm-chain-service.ts`.
 * Splitting it out keeps the pattern obvious and lets per-chain
 * providers reuse it without duplicating the regex set.
 */

const SUSPICIOUS_PATTERNS: readonly RegExp[] = [
  /https?:\/\//i,
  /www\./i,
  /\.com|\.xyz|\.cc|\.io|\.app|\.eu|\.org/i,
  /claim|visit|reward|bonus|airdrop/i,
  /^\$/,
  /t\.me|telegram/i,
  /swap.*on|claim.*on/i,
  /<|>|\{|\}|\[|\]/i,
];

export function isLikelySpamToken(token: { name: string; symbol: string }): boolean {
  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(token.name)) return true;
    if (pattern.test(token.symbol)) return true;
  }
  return false;
}

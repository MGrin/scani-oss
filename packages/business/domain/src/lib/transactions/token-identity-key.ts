import type { NewToken } from '@scani/db/schema';

/**
 * The key a transaction import counts a provider's token by: its EVM contract
 * where it names one, otherwise its symbol and segment. A Solana mint is not
 * in it, so unknown mints that share a symbol are one token in the wallet
 * review's skip notice (A2 R36).
 */
export function identityCacheKey(identity: Partial<NewToken>): string {
  const meta = identity.providerMetadata as Record<string, unknown> | undefined;
  // Prefer the most-specific identity component for cache keying.
  if (meta && typeof meta === 'object') {
    const eth = meta.etherscan as { chainId?: number; contractAddress?: string } | undefined;
    if (eth?.chainId && eth.contractAddress) {
      return `evm:${eth.chainId}:${eth.contractAddress.toLowerCase()}`;
    }
  }
  return `sym:${(identity.symbol ?? '').toUpperCase()}:${identity.marketSegment ?? ''}`;
}

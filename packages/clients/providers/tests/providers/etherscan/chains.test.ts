import { describe, expect, test } from 'bun:test';
import { ETHERSCAN_CHAINS } from '../../../src/providers/etherscan/chains';

/**
 * Mainnet chain ids Etherscan V2 serves, from
 * `GET https://api.etherscan.io/v2/chainlist` on 2026-10-03 (SC-1524).
 *
 * A chain id outside this list is refused with `Missing or unsupported
 * chainid parameter` before the key is even read, so cataloguing one turns
 * every wallet import and every hourly sync into a permanent "could not be
 * read" for that chain. Refresh the snapshot from the same URL when adding a
 * chain; it is checked in so the test needs no network.
 */
const ETHERSCAN_V2_MAINNET_CHAIN_IDS: ReadonlySet<number> = new Set([
  1, // Ethereum Mainnet
  56, // BNB Smart Chain Mainnet
  137, // Polygon Mainnet
  8453, // Base Mainnet
  42161, // Arbitrum One Mainnet
  59144, // Linea Mainnet
  81457, // Blast Mainnet
  10, // OP Mainnet
  43114, // Avalanche C-Chain
  199, // BitTorrent Chain Mainnet
  42220, // Celo Mainnet
  252, // Fraxtal Mainnet
  100, // Gnosis
  5000, // Mantle Mainnet
  4352, // Memecore Mainnet
  204, // opBNB Mainnet
  167000, // Taiko Mainnet
  50, // XDC Mainnet
  33139, // ApeChain Mainnet
  480, // World Mainnet
  146, // Sonic Mainnet
  130, // Unichain Mainnet
  2741, // Abstract Mainnet
  80094, // Berachain Mainnet
  143, // Monad Mainnet
  999, // HyperEVM Mainnet
  747474, // Katana Mainnet
  1329, // Sei Mainnet
  988, // Stable Mainnet
  9745, // Plasma Mainnet
  4326, // MegaETH Mainnet
  4663, // Robinhood Chain
  5042, // Arc Mainnet
]);

describe('ETHERSCAN_CHAINS', () => {
  test('every catalogued chain is one Etherscan V2 serves', () => {
    const unserved = ETHERSCAN_CHAINS.filter(
      (c) => !ETHERSCAN_V2_MAINNET_CHAIN_IDS.has(c.chainId)
    ).map((c) => `${c.institutionCode} (${c.chainId})`);
    expect(unserved).toEqual([]);
  });

  test('chain ids and institution codes are unique', () => {
    const ids = ETHERSCAN_CHAINS.map((c) => c.chainId);
    const codes = ETHERSCAN_CHAINS.map((c) => c.institutionCode);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

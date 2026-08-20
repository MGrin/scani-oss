import { describe, expect, test } from 'bun:test';
import {
  CHAIN_ID_TO_COINGECKO_PLATFORM,
  COINGECKO_SOLANA_PLATFORM,
} from '../../src/providers/coingecko/chains';
import {
  contractRefFromMetadata,
  resolveCoingeckoId,
  WELL_KNOWN_COINGECKO_DEPLOYMENTS,
  WELL_KNOWN_COINGECKO_IDS,
} from '../../src/providers/coingecko/well-known-ids';

/**
 * SC-391. `pol` mapped to `pol-ex-matic`, an id absent from CoinGecko's
 * `/coins/list` (verified 2026-08-18 against the full 18,452-coin list,
 * not a single lookup that could have been rate-limited). The live id is
 * `polygon-ecosystem-token`.
 *
 * The failure this caused is the one SC-217 named, arriving by a
 * different route: `canPrice` returns true because an id resolved, every
 * CoinGecko request for it 404s, and the row is unpriced while the code
 * believes it has a pricing provider. Nothing in production carried POL
 * when this was found — it goes live the moment anyone migrates off
 * MATIC, which is the entire point of the token.
 */

const POL_ETHEREUM = '0x455e53cbb86018ac2b8092fdcd39d8444affc3f6';
const POL_POLYGON_PREDEPLOY = '0x0000000000000000000000000000000000001010';

describe('SC-391 — POL resolves to the id CoinGecko actually serves', () => {
  test('the dead `pol-ex-matic` slug is gone', () => {
    expect(WELL_KNOWN_COINGECKO_IDS.pol).toBe('polygon-ecosystem-token');
    expect(Object.values(WELL_KNOWN_COINGECKO_IDS)).not.toContain('pol-ex-matic');
  });

  test('POL on its Ethereum deployment resolves', () => {
    expect(
      resolveCoingeckoId({
        symbol: 'POL',
        contract: contractRefFromMetadata({
          etherscan: { chainId: 1, contractAddress: POL_ETHEREUM },
        }),
      })
    ).toBe('polygon-ecosystem-token');
  });

  /**
   * The trap the ticket names. `0x…1010` is POL's *predeploy* on Polygon
   * PoS — a genuine contract that reads like a null address. It is also
   * the deployment most POL holders actually hold, so a guard that
   * special-cases leading zeros refuses the common case and admits
   * nothing in exchange.
   */
  test('POL on the Polygon predeploy resolves despite looking null-ish', () => {
    expect(
      resolveCoingeckoId({
        symbol: 'POL',
        contract: contractRefFromMetadata({
          etherscan: { chainId: 137, contractAddress: POL_POLYGON_PREDEPLOY },
        }),
      })
    ).toBe('polygon-ecosystem-token');
  });

  test('a POL impostor on either recorded chain is refused', () => {
    expect(
      resolveCoingeckoId({
        symbol: 'POL',
        contract: contractRefFromMetadata({
          etherscan: { chainId: 1, contractAddress: '0xdead00000000000000000000000000000000beef' },
        }),
      })
    ).toBeNull();
    expect(
      resolveCoingeckoId({
        symbol: 'POL',
        contract: contractRefFromMetadata({
          etherscan: {
            chainId: 137,
            contractAddress: '0x0000000000000000000000000000000000001011',
          },
        }),
      })
    ).toBeNull();
  });
});

/**
 * The two tables are written by hand from a `/coins/list` read, and a
 * renamed slug is invisible at the call site — `resolveCoingeckoId`
 * happily returns an id no upstream serves. These assert the parts of
 * that consistency a test can check without a network call; the part it
 * cannot (does the id still exist upstream) is what SC-391 was.
 */
describe('the well-known tables agree with each other', () => {
  test('every id with recorded deployments is an id the symbol map can produce', () => {
    const reachable = new Set(Object.values(WELL_KNOWN_COINGECKO_IDS));
    for (const id of Object.keys(WELL_KNOWN_COINGECKO_DEPLOYMENTS)) {
      expect(reachable).toContain(id);
    }
  });

  test('every recorded platform is one a scani provider can produce a contract for', () => {
    const producible = new Set<string>([
      ...Object.values(CHAIN_ID_TO_COINGECKO_PLATFORM),
      COINGECKO_SOLANA_PLATFORM,
    ]);
    for (const [id, deployments] of Object.entries(WELL_KNOWN_COINGECKO_DEPLOYMENTS)) {
      for (const platform of Object.keys(deployments)) {
        expect({ id, platform, producible: producible.has(platform) }).toEqual({
          id,
          platform,
          producible: true,
        });
      }
    }
  });
});

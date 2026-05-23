/**
 * ENS reverse-resolution helpers — feeds the optional
 * `AddressValidatorProvider.resolveAddressName` capability on the
 * Ethereum mainnet `EtherscanProvider` instance.
 *
 * The lookup is two `eth_call` round-trips against `https://eth.llamarpc.com`:
 *   1. ENS Registry `resolver(bytes32)` → resolver contract address
 *   2. Resolver contract `name(bytes32)` → ENS label (ABI-encoded string)
 *
 * Pre-refactor source: `packages/integrations/src/blockchain-services/evm-chain-service.ts`
 * (ENS section + namehash + decodeAbiString helpers).
 */

import { keccak_256 } from '@noble/hashes/sha3';
import { fetchWithTimeout } from '../../core/utils/fetch';

const ETH_RPC_URL = 'https://eth.llamarpc.com';
const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
// resolver(bytes32) selector
const RESOLVER_SELECTOR = '0x0178b8bf';
// name(bytes32) selector
const NAME_SELECTOR = '0x691f3431';

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function keccak256Hex(data: string): string {
  return bytesToHex(keccak_256(new TextEncoder().encode(data)));
}

function keccak256HexConcat(a: string, b: string): string {
  return bytesToHex(keccak_256(hexToBytes(a + b)));
}

/**
 * Compute the ENS namehash for a domain name (EIP-137).
 */
function namehash(name: string): string {
  let node = '0'.repeat(64); // namehash('') = 0x00...00
  if (name) {
    const labels = name.split('.');
    for (let i = labels.length - 1; i >= 0; i--) {
      const label = labels[i] ?? '';
      const labelHash = keccak256Hex(label);
      node = keccak256HexConcat(node, labelHash);
    }
  }
  return node;
}

/**
 * Decode an ABI-encoded `string` returned by an `eth_call`. The
 * encoding is: 32-byte offset, 32-byte length, then the UTF-8 bytes.
 */
function decodeAbiString(hex: string): string | null {
  try {
    const data = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (data.length < 128) return null;
    const length = Number.parseInt(data.slice(64, 128), 16);
    if (length === 0 || length > 1000) return null;
    const strHex = data.slice(128, 128 + length * 2);
    return new TextDecoder().decode(hexToBytes(strHex));
  } catch {
    return null;
  }
}

/**
 * Reverse-resolve an Ethereum address to an ENS name (e.g.
 * `0xd8d…` → `vitalik.eth`). Returns null when no name is set, the
 * RPC call fails, or the address is malformed.
 */
export async function resolveEnsName(address: string): Promise<string | null> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return null;

  try {
    const addrLower = address.toLowerCase().slice(2);
    const reverseNode = `${addrLower}.addr.reverse`;
    const node = namehash(reverseNode);

    // Step 1: get the resolver contract for this reverse node.
    const resolverCalldata = `${RESOLVER_SELECTOR}${node}`;
    const resolverResponse = await fetchWithTimeout(ETH_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: ENS_REGISTRY, data: resolverCalldata }, 'latest'],
      }),
    });
    const resolverData = (await resolverResponse.json()) as { result?: string };
    if (!resolverData.result || resolverData.result === `0x${'0'.repeat(64)}`) {
      return null;
    }
    const resolverAddr = `0x${resolverData.result.slice(26)}`;
    if (resolverAddr === `0x${'0'.repeat(40)}`) return null;

    // Step 2: ask the resolver for the actual name string.
    const nameCalldata = `${NAME_SELECTOR}${node}`;
    const nameResponse = await fetchWithTimeout(ETH_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: resolverAddr, data: nameCalldata }, 'latest'],
      }),
    });
    const nameData = (await nameResponse.json()) as { result?: string };
    if (!nameData.result || nameData.result.length <= 2) return null;
    return decodeAbiString(nameData.result);
  } catch {
    return null;
  }
}

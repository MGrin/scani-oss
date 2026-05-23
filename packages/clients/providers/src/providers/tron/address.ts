/**
 * TRON base58check ↔ hex helpers.
 *
 * TronGrid mixes the two address encodings across endpoints:
 *  - `/v1/accounts/{addr}/transactions` returns native-tx contract
 *    parameters with `owner_address` / `to_address` as 21-byte HEX
 *    (`41` mainnet version byte + 20-byte address).
 *  - `/v1/accounts/{addr}/transactions/trc20` returns `from` / `to` as
 *    base58check (`Tx...`).
 *
 * We canonicalize once: the wallet's base58 address gets decoded to its
 * 21-byte hex form so native-tx comparisons are a string match, and
 * the same base58 string is reused as-is for TRC20 comparisons.
 */

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP: Record<string, number> = {};
for (let i = 0; i < BASE58_ALPHABET.length; i++) {
  BASE58_MAP[BASE58_ALPHABET[i] as string] = i;
}

export function base58Decode(input: string): Uint8Array {
  if (input.length === 0) return new Uint8Array(0);
  let zeros = 0;
  while (zeros < input.length && input[zeros] === '1') zeros++;

  const bytes: number[] = [];
  for (let i = zeros; i < input.length; i++) {
    const ch = input[i] as string;
    const value = BASE58_MAP[ch];
    if (value === undefined) {
      throw new Error(`base58Decode: invalid character '${ch}' at position ${i}`);
    }
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += (bytes[j] as number) * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[zeros + i] = bytes[bytes.length - 1 - i] as number;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * Convert a TRON base58check address (`Tx...`, 34 chars) to its 21-byte
 * hex form (42 chars, lowercase, leading `41`). Strips the trailing
 * 4-byte checksum without re-validating it — TronGrid responses round
 * trip through the same scheme so any malformed input would fail at the
 * regex gate before reaching here.
 */
export function tronBase58ToHex(address: string): string {
  const decoded = base58Decode(address);
  if (decoded.length !== 25) {
    throw new Error(`tronBase58ToHex: expected 25 bytes, got ${decoded.length}`);
  }
  return bytesToHex(decoded.slice(0, 21));
}

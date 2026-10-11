/**
 * The associated token account (ATA) a wallet holds for a mint under the
 * classic SPL Token program: the program-derived address of
 * `[wallet, tokenProgram, mint]` under the ATA program.
 *
 * It exists here for one reader. Token balances in transactions from before
 * the RPC's `owner` field carry no owner, and `getTransactionsForAddress`
 * returns them as recorded; the ATA is how such a balance is recognised as
 * the wallet's (SC-1578). No Solana SDK is a dependency, so the derivation
 * (base58 and the ed25519 off-curve test a PDA needs) is spelled out.
 */

import { sha256 } from '@noble/hashes/sha256';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress');

function base58Decode(value: string): Uint8Array {
  let n = 0n;
  for (const char of value) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) throw new Error(`not base58: ${value}`);
    n = n * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const char of value) {
    if (char !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const byte of bytes) n = n * 256n + BigInt(byte);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

const P = 2n ** 255n - 19n;
const mod = (a: bigint) => ((a % P) + P) % P;
function pow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b);
    b = mod(b * b);
    e >>= 1n;
  }
  return result;
}
const D = mod(-121665n * pow(121666n, P - 2n));
const SQRT_M1 = pow(2n, (P - 1n) / 4n);

/** Whether 32 bytes decode to a point on ed25519 (RFC 8032 §5.1.3). A PDA
    is by definition a hash that does NOT, so no private key can sign for it. */
function isOnCurve(bytes: Uint8Array): boolean {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i] ?? 0);
  const sign = y >> 255n;
  y &= (1n << 255n) - 1n;
  if (y >= P) return false;
  const u = mod(y * y - 1n);
  const v = mod(D * y * y + 1n);
  let x = mod(u * pow(v, 3n) * pow(u * pow(v, 7n), (P - 5n) / 8n));
  const vx2 = mod(v * x * x);
  if (vx2 === mod(-u)) x = mod(x * SQRT_M1);
  else if (vx2 !== u) return false;
  return !(x === 0n && sign === 1n);
}

const cache = new Map<string, string>();

export function associatedTokenAddress(wallet: string, mint: string): string {
  const key = `${wallet}:${mint}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const seeds = [base58Decode(wallet), base58Decode(TOKEN_PROGRAM), base58Decode(mint)];
  const program = base58Decode(ATA_PROGRAM);
  for (let bump = 255; bump >= 0; bump--) {
    const hash = sha256.create();
    for (const seed of seeds) hash.update(seed);
    hash.update(Uint8Array.of(bump));
    hash.update(program);
    hash.update(PDA_MARKER);
    const candidate = hash.digest();
    if (!isOnCurve(candidate)) {
      const address = base58Encode(candidate);
      cache.set(key, address);
      return address;
    }
  }
  throw new Error(`no program address for ${key}`);
}

import { sha256 } from '@noble/hashes/sha256';
import { bech32, bech32m, createBase58check } from '@scure/base';

const base58check = createBase58check(sha256);

export function normalizeLitecoinAddress(address: string): string | null {
  if (address.length > 90) return null;
  try {
    if (/^ltc1/i.test(address)) {
      const decoded = bech32.decodeUnsafe(address) || bech32m.decodeUnsafe(address);
      if (decoded?.prefix !== 'ltc') return null;
      const version = decoded.words[0];
      if (version === undefined || version > 16) return null;
      const codec = version === 0 ? bech32 : bech32m;
      if (!codec.decodeUnsafe(address)) return null;
      const program = codec.fromWords(decoded.words.slice(1));
      if (program.length < 2 || program.length > 40) return null;
      if (version === 0 && program.length !== 20 && program.length !== 32) return null;
      return address.toLowerCase();
    }

    const payload = base58check.decode(address);
    if (payload.length !== 21) return null;
    const version = payload[0];
    if (version !== 48 && version !== 50 && version !== 5) return null;
    if (version === 5) {
      payload[0] = 50;
      return base58check.encode(payload);
    }
    return address;
  } catch {
    return null;
  }
}

export function isLitecoinAddress(address: string): boolean {
  return normalizeLitecoinAddress(address) !== null;
}

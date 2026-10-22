import { describe, expect, test } from 'bun:test';
import { sha256 } from '@noble/hashes/sha256';
import { bech32, bech32m, createBase58check } from '@scure/base';
import { isLitecoinAddress, normalizeLitecoinAddress } from '../../src/validators/litecoin';

const base58check = createBase58check(sha256);
const hash = Uint8Array.from({ length: 20 }, (_, index) => index);

function legacy(version: number, bytes = hash): string {
  return base58check.encode(Uint8Array.from([version, ...bytes]));
}

function witness(version: number, length: number, prefix = 'ltc'): string {
  const codec = version === 0 ? bech32 : bech32m;
  const program = Uint8Array.from({ length }, (_, index) => index);
  return codec.encode(prefix, [version, ...codec.toWords(program)], false);
}

describe('Litecoin mainnet addresses', () => {
  test('accepts fixed mainnet vectors across supported script types', () => {
    for (const address of [
      'LKDyUEtTR1HXamkiEphisSiBJu6o3ZPE34',
      'M7uBSTV2qNDHDe2tHfNMqhFkZucgRMpJQk',
      '31h38a54tFMrR8kzBnP2241MFD2EUHtGha',
      'ltc1qqqqsyqcyq5rqwzqfpg9scrgwpugpzysn3s44dy',
      'ltc1qqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sp89z3m',
      'ltc1pqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sts9tf8',
    ]) {
      expect(isLitecoinAddress(address)).toBe(true);
    }
    expect(normalizeLitecoinAddress('31h38a54tFMrR8kzBnP2241MFD2EUHtGha')).toBe(
      'M7uBSTV2qNDHDe2tHfNMqhFkZucgRMpJQk'
    );
  });

  test('accepts P2PKH and current P2SH without changing their spelling', () => {
    for (const version of [48, 50]) {
      const address = legacy(version);
      expect(isLitecoinAddress(address)).toBe(true);
      expect(normalizeLitecoinAddress(address)).toBe(address);
    }
  });

  test('normalizes historical P2SH aliases to the current Litecoin version', () => {
    expect(normalizeLitecoinAddress(legacy(5))).toBe(legacy(50));
    const historical = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy';
    const canonical = normalizeLitecoinAddress(historical);
    expect(canonical).not.toBeNull();
    const payload = base58check.decode(canonical as string);
    expect(payload[0]).toBe(50);
    expect(payload.slice(1)).toEqual(base58check.decode(historical).slice(1));
  });

  test('rejects corrupted checksums, wrong network versions and wrong hash lengths', () => {
    const address = legacy(48);
    const damaged = `${address.slice(0, -1)}${address.endsWith('1') ? '2' : '1'}`;
    for (const invalid of [
      damaged,
      legacy(0),
      legacy(111),
      legacy(58),
      legacy(48, hash.slice(1)),
    ]) {
      expect(isLitecoinAddress(invalid)).toBe(false);
      expect(normalizeLitecoinAddress(invalid)).toBeNull();
    }
  });

  test('accepts both version-zero program lengths and normalizes uppercase', () => {
    for (const length of [20, 32]) {
      const address = witness(0, length);
      expect(isLitecoinAddress(address)).toBe(true);
      expect(normalizeLitecoinAddress(address.toUpperCase())).toBe(address);
    }
  });

  test('accepts every future witness version and boundary program lengths', () => {
    for (let version = 1; version <= 16; version++) {
      for (const length of [2, 17, 32, 40]) {
        expect(isLitecoinAddress(witness(version, length))).toBe(true);
      }
    }
  });

  test('rejects invalid witness versions, program lengths and network prefixes', () => {
    for (const invalid of [
      witness(0, 19),
      witness(0, 21),
      witness(0, 31),
      witness(0, 33),
      witness(1, 1),
      witness(1, 41),
      witness(17, 32),
      witness(0, 20, 'bc'),
      witness(0, 20, 'tltc'),
      witness(0, 20, 'ltcmweb'),
    ]) {
      expect(normalizeLitecoinAddress(invalid)).toBeNull();
    }
  });

  test('rejects the wrong checksum variant even when that checksum is valid', () => {
    expect(isLitecoinAddress(bech32m.encode('ltc', [0, ...bech32m.toWords(hash)]))).toBe(false);
    expect(isLitecoinAddress(bech32.encode('ltc', [1, ...bech32.toWords(hash)]))).toBe(false);
  });

  test('rejects checksum damage, mixed casing and invalid conversion padding', () => {
    const address = witness(0, 20);
    const words = bech32.toWords(hash);
    const nonzeroPadding = bech32.toWords(new Uint8Array(32));
    nonzeroPadding[nonzeroPadding.length - 1] = 1;
    for (const invalid of [
      `${address.slice(0, -1)}${address.endsWith('q') ? 'p' : 'q'}`,
      `L${address.slice(1)}`,
      bech32.encode('ltc', [0, ...words, 0]),
      bech32.encode('ltc', [0, ...nonzeroPadding]),
      '',
      ` ${address}`,
      `${address}\n`,
    ]) {
      expect(normalizeLitecoinAddress(invalid)).toBeNull();
    }
  });
});

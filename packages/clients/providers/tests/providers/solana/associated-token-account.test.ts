import { describe, expect, test } from 'bun:test';
import { associatedTokenAddress } from '../../../src/providers/solana/associated-token-account';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

describe('associatedTokenAddress', () => {
  test('derives the ATA a wallet holds on chain', () => {
    // Read 2026-10-05 with getAccountInfo: this account's owner is the
    // wallet and its mint is USDC.
    expect(associatedTokenAddress('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', USDC)).toBe(
      'FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B'
    );
  });

  test('a different mint derives a different account', () => {
    const wallet = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
    expect(associatedTokenAddress(wallet, USDT)).not.toBe(associatedTokenAddress(wallet, USDC));
  });
});

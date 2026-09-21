/**
 * Bounds on how much one wallet import may read (SC-1271).
 *
 * A wallet is named by an address anyone can type, so its size is chosen by
 * the requester, not by us. On 2026-09-19 one import of the Ethereum zero
 * address held the worker for over an hour and exhausted its memory, taking
 * the Redis it hosts with it. Every walk stops at these caps and retracts the
 * history claim, so a huge wallet imports as partial instead of taking the
 * machine down.
 */

/**
 * Rows one history walk may collect before it stops. A normalized row is about
 * a kilobyte, so the three EVM streams together stay in the tens of megabytes.
 */
export const WALLET_HISTORY_ROW_CAP = 20_000;

/**
 * Distinct tokens one balance discovery may look up. Each is its own upstream
 * call; the discovery page is newest first, so the cap keeps the tokens the
 * wallet touched most recently.
 */
export const WALLET_TOKEN_DISCOVERY_CAP = 200;

/**
 * Addresses no person holds: the EVM zero address and the conventional burn
 * sink. They collect transfers from everyone, so importing one is never a
 * user's wallet and always a very large read.
 */
const BURN_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
]);

export function isBurnAddress(address: string): boolean {
  return BURN_ADDRESSES.has(address.trim().toLowerCase());
}

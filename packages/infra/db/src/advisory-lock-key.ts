/**
 * Its own module because `advisory-lock.ts` imports the shared connection
 * pool at load time, and the migration runner must not: it brings its own
 * single connection and runs before anything else in the process is allowed
 * to talk to the database.
 */
export function advisoryLockKey(key: string): bigint {
  // FNV-1a 64-bit, then squeezed into the signed-int64 range Postgres
  // accepts. Deterministic, fast, no crypto needed (these are coordination
  // hashes, not security tokens).
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK_64 = (1n << 64n) - 1n;
  let hash = FNV_OFFSET;
  for (let i = 0; i < key.length; i++) {
    hash ^= BigInt(key.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  const SIGNED_MAX = (1n << 63n) - 1n;
  return hash > SIGNED_MAX ? hash - (1n << 64n) : hash;
}

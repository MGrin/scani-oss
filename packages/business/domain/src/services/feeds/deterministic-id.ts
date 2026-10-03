import { createHash } from 'node:crypto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * RFC 4122 version 5: SHA-1 over the namespace's 16 bytes then the UTF-8 name.
 * The namespace must be a UUID, because those bytes are what gets hashed.
 */
export function deterministicUuid(namespace: string, name: string): string {
  if (!UUID_PATTERN.test(namespace)) {
    throw new TypeError(`deterministicUuid: namespace must be a UUID, got "${namespace}"`);
  }
  const digest = createHash('sha1')
    .update(Buffer.from(namespace.replaceAll('-', ''), 'hex'))
    .update(name, 'utf8')
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

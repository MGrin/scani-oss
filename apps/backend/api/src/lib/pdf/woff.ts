import { inflateSync } from 'node:zlib';

/**
 * A WOFF 1.0 file as the plain sfnt (TrueType/OpenType) it wraps.
 *
 * pdfkit re-parses a registered face for every document, and fontkit inflates a
 * WOFF's tables with `tiny-inflate`, in JavaScript. On the Japanese face that
 * was 98% of a statement render: 3.4s warm, for a document whose text barely
 * changes it (SC-1593). Unwrapping once, natively, leaves fontkit nothing to
 * inflate. The tables are byte-for-byte the ones the WOFF carries, so the
 * glyphs a document embeds are the same.
 *
 * Bytes that are not WOFF come back unchanged.
 */
export function woffToSfnt(bytes: Buffer): Buffer {
  if (bytes.length < 44 || bytes.toString('latin1', 0, 4) !== 'wOFF') return bytes;
  const flavor = bytes.readUInt32BE(4);
  const numTables = bytes.readUInt16BE(12);

  const tables = Array.from({ length: numTables }, (_, index) => {
    const entry = 44 + index * 20;
    const offset = bytes.readUInt32BE(entry + 4);
    const compLength = bytes.readUInt32BE(entry + 8);
    const origLength = bytes.readUInt32BE(entry + 12);
    const stored = bytes.subarray(offset, offset + compLength);
    const data = compLength < origLength ? inflateSync(stored) : stored;
    if (data.length !== origLength) {
      throw new Error(`woff table ${index} inflated to ${data.length}, expected ${origLength}`);
    }
    return { tag: bytes.readUInt32BE(entry), checksum: bytes.readUInt32BE(entry + 16), data };
  });

  const pad = (length: number) => (length + 3) & ~3;
  const headerLength = 12 + numTables * 16;
  const out = Buffer.alloc(
    headerLength + tables.reduce((sum, table) => sum + pad(table.data.length), 0)
  );

  let power = 1;
  let log = 0;
  while (power * 2 <= numTables) {
    power *= 2;
    log += 1;
  }
  out.writeUInt32BE(flavor, 0);
  out.writeUInt16BE(numTables, 4);
  out.writeUInt16BE(power * 16, 6);
  out.writeUInt16BE(log, 8);
  out.writeUInt16BE(numTables * 16 - power * 16, 10);

  let at = headerLength;
  tables.forEach((table, index) => {
    const record = 12 + index * 16;
    out.writeUInt32BE(table.tag, record);
    out.writeUInt32BE(table.checksum, record + 4);
    out.writeUInt32BE(at, record + 8);
    out.writeUInt32BE(table.data.length, record + 12);
    table.data.copy(out, at);
    at += pad(table.data.length);
  });
  return out;
}

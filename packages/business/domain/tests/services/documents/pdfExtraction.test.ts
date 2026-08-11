import { describe, expect, test } from 'bun:test';
import { extractText } from '../../../src/services/documents/pdfExtraction';

// Fixtures are built by hand rather than committed as binary blobs — a
// minimal PDF (catalog, one page, one content stream, correct xref
// offsets) is small enough to construct inline and stays portable across
// dev machines and CI, unlike a `cupsfilter`-generated file which only
// exists on macOS.
function buildPdf(objects: string[]): Uint8Array {
  const enc = new TextEncoder();
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(enc.encode(body).length);
    body += obj;
  }
  const xrefStart = enc.encode(body).length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  }
  body += xref;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return enc.encode(body);
}

function buildTextPdf(text: string): Uint8Array {
  const content = `BT /F1 18 Tf 20 150 Td (${text}) Tj ET`;
  const contentLength = new TextEncoder().encode(content).length;
  return buildPdf([
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${contentLength} >>\nstream\n${content}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ]);
}

// A page with a valid Contents stream that carries no drawable text —
// the same shape a scanned page (image XObject, no text layer) reduces
// to as far as the parser's text layer is concerned. Cheap to build,
// and it is `pagesNeedingOcr` that must drive the verdict, so a real
// scanned image isn't needed to prove the routing.
function buildTextlessPdf(): Uint8Array {
  return buildPdf([
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << >> >>\nendobj\n',
    '4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n',
  ]);
}

describe('extractText', () => {
  test('returns non-empty markdown containing the document words for a text-based PDF', () => {
    const bytes = buildTextPdf('Hello World Invoice INV-1001');

    const markdown = extractText(bytes);

    expect(markdown.length).toBeGreaterThan(0);
    expect(markdown).toContain('Hello World Invoice INV-1001');
  });

  test('returns an empty string for unparseable bytes, instead of throwing', () => {
    const bytes = new TextEncoder().encode('not a pdf, just plain bytes');

    expect(() => extractText(bytes)).not.toThrow();
    expect(extractText(bytes)).toBe('');
  });
});

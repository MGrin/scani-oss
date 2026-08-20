/**
 * Client-side helper to upload a file directly to R2 via a presigned URL.
 *
 * The backend's presigner binds `content-type` and `content-length` into
 * the SigV4 signature, so callers MUST forward every header returned in
 * `requiredHeaders` verbatim — any mismatch (wrong content-type, wrong
 * size) produces a 403 from R2.
 */

export interface R2UploadOptions {
  uploadUrl: string;
  requiredHeaders: Record<string, string>;
}

export async function uploadToR2(file: File | Blob, options: R2UploadOptions): Promise<void> {
  // Browsers compute Content-Length automatically from the Blob body and
  // refuse any explicit override. R2 still validates the length against
  // the signature, so we drop it here — the signed length is authoritative.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(options.requiredHeaders)) {
    if (k.toLowerCase() === 'content-length') continue;
    headers[k] = v;
  }
  const res = await fetch(options.uploadUrl, {
    method: 'PUT',
    headers,
    body: file,
  });
  if (!res.ok) {
    throw new Error(`R2 upload failed: ${res.status} ${await res.text()}`);
  }
}

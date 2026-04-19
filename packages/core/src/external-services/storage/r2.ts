/**
 * Cloudflare R2 client — S3-compatible, SigV4-signed, zero AWS-SDK dependency.
 *
 * Used for temporary job payload storage: the frontend uploads large blobs
 * (screenshots, CSV files) directly to R2 via a presigned PUT URL, then
 * passes the storage key in the BullMQ job payload. Workers read the blob,
 * process it, and delete on success — a 24h bucket lifecycle rule cleans up
 * orphans from failed jobs.
 *
 * Required env vars (backend + worker):
 *   - R2_ACCOUNT_ID
 *   - R2_ACCESS_KEY_ID
 *   - R2_SECRET_ACCESS_KEY
 *   - R2_BUCKET
 *
 * R2 speaks standard S3 SigV4 with region="auto". Endpoint:
 *   https://<account_id>.r2.cloudflarestorage.com/<bucket>/<key>
 */

import { createHash, createHmac } from 'node:crypto';

const REGION = 'auto';
const SERVICE = 's3';
const TEMP_PREFIX = 'temp/';

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

function loadConfig(): R2Config {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      'R2 env misconfigured: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET are all required.'
    );
  }
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

function endpoint(cfg: R2Config): string {
  return `https://${cfg.accountId}.r2.cloudflarestorage.com`;
}

function host(cfg: R2Config): string {
  return `${cfg.accountId}.r2.cloudflarestorage.com`;
}

function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function amzDate(now: Date = new Date()): { amz: string; dateStamp: string } {
  const iso = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  return { amz: iso, dateStamp: iso.slice(0, 8) };
}

function uriEncode(str: string, encodeSlash = true): string {
  return str.replace(/[^A-Za-z0-9_.~-]/g, (c) => {
    if (c === '/' && !encodeSlash) return c;
    return `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
  });
}

function sign(
  cfg: R2Config,
  method: 'GET' | 'PUT' | 'DELETE' | 'HEAD',
  canonicalPath: string,
  canonicalQuery: string,
  payloadHash: string,
  now: Date,
  extraHeaders: Record<string, string> = {}
): { authorization: string; amzDateStr: string; signedHeaders: string } {
  const { amz, dateStamp } = amzDate(now);
  const headers: Record<string, string> = {
    host: host(cfg),
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amz,
    ...extraHeaders,
  };
  const sortedHeaderNames = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders = `${sortedHeaderNames
    .map((h) => `${h}:${(headers[h] ?? '').trim().replace(/\s+/g, ' ')}`)
    .join('\n')}\n`;
  const signedHeaders = sortedHeaderNames.join(';');

  const canonicalRequest = [
    method,
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amz, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { authorization, amzDateStr: amz, signedHeaders };
}

interface PresignExtraHeaders {
  contentType?: string;
  contentLength?: number;
}

/**
 * Build a presigned URL. For PUT uploads we bind `content-type` and
 * `content-length` into the signature so the client cannot substitute an
 * arbitrary payload shape after we hand out the URL. R2 enforces the
 * signed-headers contract and will 403 on any mismatched header.
 */
function presign(
  cfg: R2Config,
  method: 'GET' | 'PUT',
  key: string,
  expiresSeconds: number,
  extraHeaders: PresignExtraHeaders = {},
  now: Date = new Date()
): string {
  const { amz, dateStamp } = amzDate(now);
  const canonicalPath = `/${cfg.bucket}/${uriEncode(key, false)}`;
  const credential = `${cfg.accessKeyId}/${dateStamp}/${REGION}/${SERVICE}/aws4_request`;

  // Build the signed-headers set. `host` is mandatory. For PUT we bind
  // content-type and content-length so neither the client nor a network
  // observer can alter them between signing and upload.
  const headerMap: Record<string, string> = { host: host(cfg) };
  if (method === 'PUT') {
    if (extraHeaders.contentType) {
      headerMap['content-type'] = extraHeaders.contentType;
    }
    if (typeof extraHeaders.contentLength === 'number') {
      headerMap['content-length'] = String(extraHeaders.contentLength);
    }
  }
  const sortedHeaderNames = Object.keys(headerMap).sort();
  const canonicalHeaders = `${sortedHeaderNames
    .map((h) => `${h}:${(headerMap[h] ?? '').trim().replace(/\s+/g, ' ')}`)
    .join('\n')}\n`;
  const signedHeaders = sortedHeaderNames.join(';');

  const params = new URLSearchParams();
  params.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  params.set('X-Amz-Credential', credential);
  params.set('X-Amz-Date', amz);
  params.set('X-Amz-Expires', String(expiresSeconds));
  params.set('X-Amz-SignedHeaders', signedHeaders);
  // Keys sorted alphabetically — URLSearchParams does not sort. Build manually:
  const sortedParams = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b));
  const canonicalQuery = sortedParams.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join('&');

  const payloadHash = 'UNSIGNED-PAYLOAD';

  const canonicalRequest = [
    method,
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amz, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  return `${endpoint(cfg)}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export interface PresignedUpload {
  uploadUrl: string;
  key: string;
  expiresAt: string;
  /**
   * Headers the client MUST send verbatim on the PUT. These are bound
   * into the signature — R2 will reject the upload if any mismatches.
   */
  requiredHeaders: Record<string, string>;
}

/**
 * Build a presigned PUT URL for direct-to-R2 upload from the frontend.
 *
 * Key is scoped under `temp/` so the bucket lifecycle rule can sweep
 * orphans left by failed jobs. Content-Type and Content-Length are bound
 * into the signature so the admission-time validation in the backend
 * (allowlisted MIME types, 8 MB size cap) is also enforced at R2 —
 * without this, a malicious client could PUT arbitrary bytes of any size
 * under an allowlisted MIME label.
 */
export function presignUpload(options: {
  keyPrefix: string;
  extension: string;
  contentType: string;
  contentLength: number;
  ttlSeconds?: number;
}): PresignedUpload {
  const cfg = loadConfig();
  const ttl = options.ttlSeconds ?? 15 * 60;
  const randomId = crypto.randomUUID();
  const key = `${TEMP_PREFIX}${options.keyPrefix}/${randomId}.${options.extension.replace(/^\./, '')}`;
  const uploadUrl = presign(cfg, 'PUT', key, ttl, {
    contentType: options.contentType,
    contentLength: options.contentLength,
  });
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  return {
    uploadUrl,
    key,
    expiresAt,
    requiredHeaders: {
      'content-type': options.contentType,
      'content-length': String(options.contentLength),
    },
  };
}

/** Build a presigned GET URL for reading a temp blob (worker side). */
export function presignDownload(key: string, ttlSeconds = 5 * 60): string {
  const cfg = loadConfig();
  return presign(cfg, 'GET', key, ttlSeconds);
}

/** Fetch a temp blob from R2 using an inline SigV4-signed GET. */
export async function readTempBlob(key: string): Promise<Buffer> {
  const cfg = loadConfig();
  const now = new Date();
  const payloadHash = sha256Hex('');
  const canonicalPath = `/${cfg.bucket}/${uriEncode(key, false)}`;
  const { authorization, amzDateStr } = sign(cfg, 'GET', canonicalPath, '', payloadHash, now);
  const res = await fetch(`${endpoint(cfg)}${canonicalPath}`, {
    method: 'GET',
    headers: {
      host: host(cfg),
      authorization,
      'x-amz-date': amzDateStr,
      'x-amz-content-sha256': payloadHash,
    },
  });
  if (!res.ok) {
    throw new Error(`R2 GET ${key} failed: ${res.status} ${await res.text()}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Verify R2 connectivity + credentials. Does a signed HEAD on a nonexistent
 * key — a 404 or 200 means auth worked; a 401/403/timeout means config is
 * wrong. Returns `{ ok: true, latencyMs }` on success, `{ ok: false, error }`
 * otherwise. Never throws.
 */
export async function healthCheck(): Promise<
  { ok: true; latencyMs: number } | { ok: false; error: string }
> {
  try {
    const cfg = loadConfig();
    const now = new Date();
    const key = '__healthcheck__/nonexistent';
    const payloadHash = sha256Hex('');
    const canonicalPath = `/${cfg.bucket}/${uriEncode(key, false)}`;
    const { authorization, amzDateStr } = sign(cfg, 'HEAD', canonicalPath, '', payloadHash, now);
    const t0 = performance.now();
    const res = await fetch(`${endpoint(cfg)}${canonicalPath}`, {
      method: 'HEAD',
      headers: {
        host: host(cfg),
        authorization,
        'x-amz-date': amzDateStr,
        'x-amz-content-sha256': payloadHash,
      },
      signal: AbortSignal.timeout(3_000),
    });
    const latencyMs = Math.round(performance.now() - t0);
    if (res.status === 200 || res.status === 404) {
      return { ok: true, latencyMs };
    }
    return { ok: false, error: `unexpected status ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Delete a temp blob from R2 (worker calls after successful processing). */
export async function deleteTempBlob(key: string): Promise<void> {
  const cfg = loadConfig();
  const now = new Date();
  const payloadHash = sha256Hex('');
  const canonicalPath = `/${cfg.bucket}/${uriEncode(key, false)}`;
  const { authorization, amzDateStr } = sign(cfg, 'DELETE', canonicalPath, '', payloadHash, now);
  const res = await fetch(`${endpoint(cfg)}${canonicalPath}`, {
    method: 'DELETE',
    headers: {
      host: host(cfg),
      authorization,
      'x-amz-date': amzDateStr,
      'x-amz-content-sha256': payloadHash,
    },
  });
  // R2 returns 204 on success, 404 is fine (already deleted / lifecycle purged).
  if (!res.ok && res.status !== 404) {
    throw new Error(`R2 DELETE ${key} failed: ${res.status} ${await res.text()}`);
  }
}

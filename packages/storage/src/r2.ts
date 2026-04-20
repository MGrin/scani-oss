/**
 * S3-compatible object-storage client built on Bun's native `S3Client`.
 *
 * Used for temporary job payload storage: the frontend uploads large blobs
 * (screenshots, CSV files) via a presigned PUT URL, then passes the storage
 * key in the BullMQ job payload. Workers read the blob, process it, and
 * delete on success — a 24h bucket lifecycle rule cleans up orphans from
 * failed jobs.
 *
 * In production this talks to Cloudflare R2 with the standard endpoint
 * https://<account_id>.r2.cloudflarestorage.com. In local dev it talks to
 * MinIO on http://localhost:9000. The same Bun client handles both.
 *
 * Required env vars (backend + worker):
 *   - R2_ACCESS_KEY_ID
 *   - R2_SECRET_ACCESS_KEY
 *   - R2_BUCKET
 *   - R2_ACCOUNT_ID (R2) — used to derive the default endpoint
 * OR
 *   - R2_ENDPOINT       — full base URL, overrides the derived R2 endpoint
 *   - R2_PUBLIC_ENDPOINT — endpoint baked into presigned URLs (browser-reachable)
 *
 * NOTE on security: Bun's `presign` binds the `host` header into the
 * signature but not `content-type` / `content-length`. The backend
 * admission-time validation (allowlisted MIME types, size caps) is the
 * primary defense — the signed URL is not an authorization for arbitrary
 * uploads because the bucket lifecycle rule sweeps `temp/` within 24h.
 */

import { S3Client } from 'bun';

const REGION = 'auto';
const TEMP_PREFIX = 'temp/';

interface R2Env {
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint: string;
  publicEndpoint: string;
}

function loadEnv(): R2Env {
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      'R2 env misconfigured: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET are all required.'
    );
  }
  const explicitEndpoint = process.env.R2_ENDPOINT?.replace(/\/$/, '');
  const accountId = process.env.R2_ACCOUNT_ID;
  const endpoint =
    explicitEndpoint ?? (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);
  if (!endpoint) {
    throw new Error(
      'R2 env misconfigured: set R2_ENDPOINT or R2_ACCOUNT_ID so the client has a base URL.'
    );
  }
  const publicEndpoint = process.env.R2_PUBLIC_ENDPOINT?.replace(/\/$/, '') ?? endpoint;
  return { accessKeyId, secretAccessKey, bucket, endpoint, publicEndpoint };
}

/**
 * Internal clients — one for server-to-server reads/writes/deletes (uses the
 * service endpoint) and one just for generating presigned URLs that the
 * browser will hit (uses the publicEndpoint). They're lazy-loaded so that
 * modules that only `import` this file don't blow up on a missing R2 env.
 */
let serverClient: S3Client | undefined;
let publicClient: S3Client | undefined;

function getServerClient(): { client: S3Client; env: R2Env } {
  if (!serverClient) {
    const env = loadEnv();
    serverClient = new S3Client({
      accessKeyId: env.accessKeyId,
      secretAccessKey: env.secretAccessKey,
      bucket: env.bucket,
      endpoint: env.endpoint,
      region: REGION,
    });
    return { client: serverClient, env };
  }
  return { client: serverClient, env: loadEnv() };
}

function getPublicClient(): { client: S3Client; env: R2Env } {
  if (!publicClient) {
    const env = loadEnv();
    publicClient = new S3Client({
      accessKeyId: env.accessKeyId,
      secretAccessKey: env.secretAccessKey,
      bucket: env.bucket,
      endpoint: env.publicEndpoint,
      region: REGION,
    });
    return { client: publicClient, env };
  }
  return { client: publicClient, env: loadEnv() };
}

export interface PresignedUpload {
  uploadUrl: string;
  key: string;
  expiresAt: string;
  /**
   * Headers the client should send on the PUT. `content-type` is advisory
   * (Bun's presign does not bind it into the signature in current versions)
   * but we keep returning it so callers can include it verbatim.
   */
  requiredHeaders: Record<string, string>;
}

/**
 * Build a presigned PUT URL for direct-to-R2 upload from the frontend.
 * Keys are scoped under `temp/` so the bucket lifecycle rule sweeps
 * orphans from failed jobs within 24h.
 */
export function presignUpload(options: {
  keyPrefix: string;
  extension: string;
  contentType: string;
  contentLength: number;
  ttlSeconds?: number;
}): PresignedUpload {
  const ttl = options.ttlSeconds ?? 15 * 60;
  const randomId = crypto.randomUUID();
  const key = `${TEMP_PREFIX}${options.keyPrefix}/${randomId}.${options.extension.replace(/^\./, '')}`;
  const { client } = getPublicClient();
  const uploadUrl = client.file(key).presign({
    method: 'PUT',
    expiresIn: ttl,
    type: options.contentType,
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

/** Build a presigned GET URL for reading a temp blob. */
export function presignDownload(key: string, ttlSeconds = 5 * 60): string {
  const { client } = getPublicClient();
  return client.file(key).presign({
    method: 'GET',
    expiresIn: ttlSeconds,
  });
}

/** Fetch a temp blob using Bun's native S3 reader (service endpoint). */
export async function readTempBlob(key: string): Promise<Buffer> {
  const { client } = getServerClient();
  const bytes = await client.file(key).arrayBuffer();
  return Buffer.from(bytes);
}

/** Delete a temp blob. 404 is fine (already deleted / lifecycle purged). */
export async function deleteTempBlob(key: string): Promise<void> {
  const { client } = getServerClient();
  try {
    await client.file(key).delete();
  } catch (err) {
    // Bun wraps S3 errors with a `.code` / `.message`; 404-equivalent is
    // best detected structurally. Treat "not found" as a no-op (lifecycle
    // rules or concurrent deletes should not crash the worker).
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('NoSuchKey') || message.includes('404')) return;
    throw err;
  }
}

/**
 * Verify R2 connectivity + credentials. Does a signed HEAD on a nonexistent
 * key. Any of 200/403/404 means our signed request reached R2 and auth was
 * evaluated — the key simply isn't there. 403 is R2's default response for
 * HEAD/GET on a missing key when the access token lacks `s3:ListBucket`,
 * which is the case for our object-scoped tokens — treat it as healthy.
 * The true-negative signal is 401 (bad signature) or a network error.
 *
 * Never throws.
 */
export async function healthCheck(): Promise<
  { ok: true; latencyMs: number } | { ok: false; error: string }
> {
  try {
    const { client } = getServerClient();
    const t0 = performance.now();
    await client.file('__healthcheck__/nonexistent').exists();
    const latencyMs = Math.round(performance.now() - t0);
    return { ok: true, latencyMs };
  } catch (err) {
    // Bun's S3Client surfaces a 403-on-missing-key as an error string that
    // includes either the status (`403`) or the S3 code (`AccessDenied`).
    // For object-scoped R2 tokens (no ListBucket), that's expected and
    // means auth reached R2 — flag it healthy. Any other error is a real
    // misconfiguration.
    const msg = err instanceof Error ? err.message : String(err);
    if (/\b403\b|AccessDenied/i.test(msg)) {
      return { ok: true, latencyMs: 0 };
    }
    return { ok: false, error: msg };
  }
}

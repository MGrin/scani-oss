import { urlSchema } from '@scani/config';
import { AwsV4Signer } from 'aws4fetch';
import { S3Client } from 'bun';
import { Service } from 'typedi';
import { z } from 'zod';
import { isMissingObjectError } from './missing-object';
import { ObjectTooLargeError } from './object-too-large';

export interface PresignUploadOptions {
  keyPrefix: string;
  extension: string;
  contentType: string;
  contentLength: number;
  ttlSeconds?: number;
}

export interface PresignedUpload {
  uploadUrl: string;
  key: string;
  expiresAt: string;
  // Both headers are signed; the browser supplies its actual Content-Length.
  requiredHeaders: Record<string, string>;
}

export type HealthResult = { ok: true; latencyMs: number } | { ok: false; error: string };

/** Target a bucket other than the configured `S3_BUCKET` for one call. */
export interface BucketOverride {
  bucket?: string;
}

export interface ReadOptions extends BucketOverride {
  /**
   * Reject oversized metadata early and cap bytes consumed from the actual
   * body independently, including when an object changes after the HEAD.
   */
  maxBytes?: number;
}

// `{ bucket: undefined }` is not the same as `undefined` to Bun's S3Client —
// the first overrides the client's configured bucket with nothing.
function bucketOpt(opts?: BucketOverride): { bucket: string } | undefined {
  return opts?.bucket ? { bucket: opts.bucket } : undefined;
}

const TEMP_PREFIX = 'temp/';
const DEFAULT_REGION = 'auto';
const DEFAULT_UPLOAD_TTL_SECONDS = 15 * 60;
const DEFAULT_DOWNLOAD_TTL_SECONDS = 5 * 60;
const HEALTH_CHECK_TIMEOUT_MS = 3_000;
// `exists` sits in front of a user-facing enqueue, so it gets its own short
// budget: the signature only has to outlive the single HEAD it signs.
const EXISTS_PRESIGN_TTL_SECONDS = 60;
const EXISTS_TIMEOUT_MS = 3_000;

// Allowed characters for caller-supplied `keyPrefix`. The prefix is
// concatenated into the S3 key (`temp/<prefix>/<uuid>.<ext>`), so a
// prefix containing `..`, `/` (apart from internal segments), or
// non-printable characters could escape the temp/ jail. The router
// passes user-supplied data through this prefix (`temp/<purpose>/<userId>`);
// the regex below caps that to safe characters.
//
// Allowed: alphanumerics, hyphens, underscores, and a single `/` between
// segments (i.e. `purpose/userId`). No `.` so `..` and `.` traversals
// are statically impossible. Empty / leading-slash / trailing-slash /
// double-slash all rejected.
const KEY_PREFIX_PATTERN = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
const MAX_KEY_PREFIX_LENGTH = 200;

// Allowed characters for the file extension. Filename extensions on
// the wire are user-provided too; constraining to alphanumerics keeps
// the assembled key safe.
const EXTENSION_PATTERN = /^[A-Za-z0-9]{1,10}$/;

// Env shape owned by this package. Callers don't declare these in their own
// env.ts schemas — they just set the env vars and the service self-validates
// on first method call.
const envSchema = z.object({
  S3_ACCESS_KEY_ID: z.string().min(1, 'S3_ACCESS_KEY_ID is required'),
  S3_SECRET_ACCESS_KEY: z.string().min(1, 'S3_SECRET_ACCESS_KEY is required'),
  S3_BUCKET: z.string().min(1, 'S3_BUCKET is required'),
  S3_ENDPOINT: urlSchema,
  S3_PUBLIC_ENDPOINT: urlSchema.optional(),
  S3_REGION: z.string().optional(),
});

// `copy` takes whole keys rather than the (prefix, extension) pair
// `presignUpload` assembles, so it can't reuse KEY_PREFIX_PATTERN. The
// keys it receives are built server-side from UUIDs, but they cross a
// tRPC boundary on the cloud path — reject the traversal shapes rather
// than trust the caller.
function assertSafeKey(key: string, label: string): void {
  if (key.length === 0 || key.length > 1024 || key.includes('..') || key.startsWith('/')) {
    throw new Error(`StorageService.copy: invalid ${label} (${key.slice(0, 64)})`);
  }
}

interface ResolvedConfig {
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint: string;
  publicEndpoint: string;
  region: string;
}

@Service()
export class StorageService {
  private cached: ResolvedConfig | null = null;
  // Two clients because the server uses a private endpoint (e.g.
  // `http://seaweedfs:8333` on the docker network) while presigned URLs need
  // the public endpoint the browser can reach (e.g. `http://localhost:9000`).
  private serverSdk: S3Client | null = null;
  private publicSdk: S3Client | null = null;

  presignUpload(opts: PresignUploadOptions): Promise<PresignedUpload> {
    const ttl = opts.ttlSeconds ?? DEFAULT_UPLOAD_TTL_SECONDS;
    const key = this.tempKey(opts, 'presignUpload');
    if (!Number.isSafeInteger(opts.contentLength) || opts.contentLength <= 0) {
      throw new Error('StorageService.presignUpload: contentLength must be a positive integer');
    }
    const cfg = this.requireConfig();
    const url = new URL(
      `${cfg.publicEndpoint.replace(/\/$/, '')}/${encodeURIComponent(cfg.bucket)}/${key}`
    );
    url.searchParams.set('X-Amz-Expires', String(ttl));
    const requiredHeaders = {
      'content-type': opts.contentType,
      'content-length': String(opts.contentLength),
    };
    // Bun's native presigner signs only host. aws4fetch must explicitly sign
    // all headers, or it too excludes Content-Length and Content-Type.
    return new AwsV4Signer({
      url: url.toString(),
      method: 'PUT',
      headers: requiredHeaders,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      region: cfg.region,
      service: 's3',
      signQuery: true,
      allHeaders: true,
    })
      .sign()
      .then(({ url }) => ({
        uploadUrl: url.toString(),
        key,
        expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
        requiredHeaders,
      }));
  }

  /**
   * Write bytes a server process produced under a fresh `temp/<prefix>/<uuid>.<ext>`
   * key, the same place a presigned upload lands, and return the key. `temp/`
   * expires on its own (30 days on R2), so an object nobody fetches does not
   * stay forever.
   */
  async writeTemp(
    opts: { keyPrefix: string; extension: string; contentType: string },
    bytes: Uint8Array
  ): Promise<string> {
    const key = this.tempKey(opts, 'writeTemp');
    await this.write(key, bytes, opts.contentType);
    return key;
  }

  private tempKey(opts: { keyPrefix: string; extension: string }, caller: string): string {
    if (opts.keyPrefix.length > MAX_KEY_PREFIX_LENGTH || !KEY_PREFIX_PATTERN.test(opts.keyPrefix)) {
      throw new Error(
        `StorageService.${caller}: invalid keyPrefix (${opts.keyPrefix.slice(0, 64)}). ` +
          'Only alphanumerics, hyphens, underscores, and `/` between segments are allowed.'
      );
    }
    const ext = opts.extension.replace(/^\./, '');
    if (!EXTENSION_PATTERN.test(ext)) {
      throw new Error(
        `StorageService.${caller}: invalid extension (${ext.slice(0, 16)}). ` +
          'Only alphanumeric extensions ≤ 10 chars are allowed.'
      );
    }
    return `${TEMP_PREFIX}${opts.keyPrefix}/${crypto.randomUUID()}.${ext}`;
  }

  presignDownload(key: string, ttlSeconds: number = DEFAULT_DOWNLOAD_TTL_SECONDS): string {
    return this.publicClient().file(key).presign({
      method: 'GET',
      expiresIn: ttlSeconds,
    });
  }

  /**
   * Whether an object is actually there, without pulling its bytes.
   *
   * A signed HEAD through `fetch` rather than Bun's `S3File.exists()`, for
   * the reason `healthCheck` gives below: `exists()` collapses every
   * non-200/404 status into one opaque error, and the status is the whole
   * answer here. Production R2 tokens are object-scoped with no
   * `s3:ListBucket`, and S3 answers HEAD-on-missing with 403 rather than 404
   * for those — so a check that only accepted 404 would call a missing
   * object an infrastructure failure on the one deployment that matters.
   *
   * 200 is the only "yes". 403 and 404 are both "no": the token demonstrably
   * reaches this bucket (it signed the upload), so a refusal on one specific
   * key means the key is not there. Anything else — 5xx, a bad signature, a
   * dropped connection — throws, because "I could not tell" must not be
   * reported as "it is missing".
   */
  async exists(key: string): Promise<boolean> {
    const res = await this.head(key);
    if (res.status === 200) return true;
    if (res.status === 403 || res.status === 404) return false;
    throw new Error(`StorageService.exists: unexpected status ${res.status} for ${key}`);
  }

  async read(key: string, opts?: ReadOptions): Promise<Buffer> {
    const file = this.serverClient().file(key, bucketOpt(opts));
    const maxBytes = opts?.maxBytes;
    if (maxBytes === undefined) return Buffer.from(await file.arrayBuffer());
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
      throw new Error('maxBytes must be a positive integer');
    await this.assertWithin(key, maxBytes, opts);
    const reader = file.stream().getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new ObjectTooLargeError(key, size, maxBytes);
        chunks.push(value);
      }
      return Buffer.concat(chunks, size);
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  private async assertWithin(key: string, maxBytes: number, opts?: BucketOverride): Promise<void> {
    const res = await this.head(key, opts);
    // Worded so `isMissingObjectError` classifies it the way it classifies
    // the body read this replaces: callers treat a missing upload as terminal.
    if (res.status === 403 || res.status === 404) throw new Error(`NoSuchKey: ${key}`);
    if (res.status !== 200) {
      throw new Error(`StorageService.read: unexpected status ${res.status} for ${key}`);
    }
    const stated = res.headers.get('content-length');
    const size = stated === null || !/^\d+$/.test(stated) ? null : Number(stated);
    if (size === null || size > maxBytes) throw new ObjectTooLargeError(key, size, maxBytes);
  }

  private head(key: string, opts?: BucketOverride): Promise<Response> {
    const url = this.serverClient().file(key, bucketOpt(opts)).presign({
      method: 'HEAD',
      expiresIn: EXISTS_PRESIGN_TTL_SECONDS,
    });
    return this.fetcher(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(EXISTS_TIMEOUT_MS),
    });
  }

  /**
   * Store bytes under a key we chose server-side.
   *
   * The upload path everything else uses is `presignUpload`, where the browser
   * does the PUT. This one is for objects the server itself produces — the
   * institution icons of SC-208 — and it takes a whole key rather than the
   * (prefix, extension) pair, so it gets `assertSafeKey` for the same reason
   * `copy` does.
   *
   * `opts.bucket` targets a bucket OTHER than `S3_BUCKET` on this one call —
   * the nightly `db-backup` job writes to the archive bucket while everything
   * else keeps writing to the job-uploads one (SC-793). It is per-call and not
   * a second configured client on purpose: moving the default is what would
   * make an unrelated upload land somewhere nobody is looking.
   */
  async write(
    key: string,
    bytes: Uint8Array,
    contentType: string,
    opts?: BucketOverride
  ): Promise<void> {
    assertSafeKey(key, 'write key');
    await this.serverClient().file(key, bucketOpt(opts)).write(bytes, { type: contentType });
  }

  /**
   * The bytes AND the content type they were written with, or `null` when the
   * object is not there.
   *
   * `read` cannot answer this: `arrayBuffer()` discards the response headers,
   * and re-serving an object needs the type it was stored with. A signed GET
   * through `fetch` — the same shape `exists` uses, and for the same reason:
   * the HTTP status is the answer, and Bun's `S3File` collapses it.
   *
   * 403 and 404 are both "not there". A production R2 token is object-scoped
   * with no `s3:ListBucket`, and S3 answers a miss with 403 for those, so a
   * check that only accepted 404 would report an absent icon as an outage on
   * the one deployment that matters.
   */
  async readObject(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    assertSafeKey(key, 'read key');
    const url = this.serverClient().file(key).presign({
      method: 'GET',
      expiresIn: EXISTS_PRESIGN_TTL_SECONDS,
    });
    const res = await this.fetcher(url, {
      method: 'GET',
      signal: AbortSignal.timeout(EXISTS_TIMEOUT_MS),
    });
    if (res.status === 403 || res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`StorageService.readObject: unexpected status ${res.status} for ${key}`);
    }
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  /**
   * Duplicate an object under a second key, leaving the source in place.
   *
   * Bun's `S3Client` exposes no server-side CopyObject, so this streams the
   * bytes through the process. Callers that want a move delete the source
   * themselves — keeping the two halves separate means a failed copy can
   * never destroy the only surviving copy of a file.
   */
  async copy(fromKey: string, toKey: string, contentType?: string): Promise<void> {
    assertSafeKey(fromKey, 'copy source');
    assertSafeKey(toKey, 'copy destination');
    const client = this.serverClient();
    const bytes = await this.read(fromKey, { maxBytes: 8 * 1024 * 1024 });
    await client.file(toKey).write(bytes, contentType ? { type: contentType } : undefined);
  }

  async delete(key: string): Promise<void> {
    try {
      await this.serverClient().file(key).delete();
    } catch (err) {
      // Already gone is fine — concurrent delete or lifecycle sweep.
      if (isMissingObjectError(err)) return;
      throw err;
    }
  }

  // Verifies bucket connectivity + credentials by issuing a signed HEAD
  // against a non-existent key.
  //
  // Healthy statuses: 200/403/404.
  //  - 200: shouldn't happen (key is non-existent by design), but fine.
  //  - 404: token has `s3:ListBucket` and the server confirms the miss.
  //  - 403: S3-default for HEAD-on-missing when the access token is
  //    object-scoped (no list permission). Production tokens are scoped
  //    that way, so 403 still proves auth reached the bucket.
  // Anything else (401 bad signature, 5xx, network error) is unhealthy.
  //
  // We use `fetch` directly because Bun's `S3File.exists()` throws a
  // generic "an unexpected error has occurred" on any non-200/404 status
  // and doesn't expose the real HTTP code, so we can't distinguish a 403
  // from a real failure.
  async healthCheck(): Promise<HealthResult> {
    try {
      const url = this.serverClient().file('__healthcheck__/nonexistent').presign({
        method: 'HEAD',
        expiresIn: 60,
      });
      const t0 = performance.now();
      const res = await this.fetcher(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });
      const latencyMs = Math.round(performance.now() - t0);
      if (res.status === 200 || res.status === 403 || res.status === 404) {
        return { ok: true, latencyMs };
      }
      return { ok: false, error: `unexpected status ${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Test hook: subclasses can override to inject a fake S3Client. */
  protected buildSdk(opts: ResolvedConfig & { endpoint: string }): S3Client {
    return new S3Client({
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      bucket: opts.bucket,
      endpoint: opts.endpoint,
      region: opts.region,
    });
  }

  /** Test hook: subclasses can override to stub the network. */
  protected fetcher(url: string, init: RequestInit): Promise<Response> {
    return fetch(url, init);
  }

  /** Test hook: subclasses can override the env source. */
  protected env(): NodeJS.ProcessEnv {
    return process.env;
  }

  private requireConfig(): ResolvedConfig {
    if (this.cached) return this.cached;
    const parsed = envSchema.safeParse(this.env());
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('\n');
      throw new Error(`StorageService env misconfigured:\n${issues}`);
    }
    const env = parsed.data;
    this.cached = {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      bucket: env.S3_BUCKET,
      endpoint: env.S3_ENDPOINT,
      publicEndpoint: env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT,
      region: env.S3_REGION ?? DEFAULT_REGION,
    };
    return this.cached;
  }

  private serverClient(): S3Client {
    if (this.serverSdk) return this.serverSdk;
    const cfg = this.requireConfig();
    this.serverSdk = this.buildSdk({ ...cfg, endpoint: cfg.endpoint });
    return this.serverSdk;
  }

  private publicClient(): S3Client {
    if (this.publicSdk) return this.publicSdk;
    const cfg = this.requireConfig();
    this.publicSdk = this.buildSdk({ ...cfg, endpoint: cfg.publicEndpoint });
    return this.publicSdk;
  }
}

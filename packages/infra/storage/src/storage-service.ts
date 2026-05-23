import { urlSchema } from '@scani/config';
import { S3Client } from 'bun';
import { Service } from 'typedi';
import { z } from 'zod';

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
  // Bun's `presign` binds `host` into the signature but not `content-type` /
  // `content-length`; we still hand them back so callers can include them
  // verbatim, and the call-site admission validation (allowlists, size caps)
  // is the real defence against arbitrary uploads.
  requiredHeaders: Record<string, string>;
}

export type HealthResult = { ok: true; latencyMs: number } | { ok: false; error: string };

const TEMP_PREFIX = 'temp/';
const DEFAULT_REGION = 'auto';
const DEFAULT_UPLOAD_TTL_SECONDS = 15 * 60;
const DEFAULT_DOWNLOAD_TTL_SECONDS = 5 * 60;
const HEALTH_CHECK_TIMEOUT_MS = 3_000;

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
  // `http://minio:9000` on the docker network) while presigned URLs need
  // the public endpoint the browser can reach (e.g. `http://localhost:9000`).
  private serverSdk: S3Client | null = null;
  private publicSdk: S3Client | null = null;

  presignUpload(opts: PresignUploadOptions): PresignedUpload {
    const ttl = opts.ttlSeconds ?? DEFAULT_UPLOAD_TTL_SECONDS;
    if (opts.keyPrefix.length > MAX_KEY_PREFIX_LENGTH || !KEY_PREFIX_PATTERN.test(opts.keyPrefix)) {
      throw new Error(
        `StorageService.presignUpload: invalid keyPrefix (${opts.keyPrefix.slice(0, 64)}). ` +
          'Only alphanumerics, hyphens, underscores, and `/` between segments are allowed.'
      );
    }
    const ext = opts.extension.replace(/^\./, '');
    if (!EXTENSION_PATTERN.test(ext)) {
      throw new Error(
        `StorageService.presignUpload: invalid extension (${ext.slice(0, 16)}). ` +
          'Only alphanumeric extensions ≤ 10 chars are allowed.'
      );
    }
    const key = `${TEMP_PREFIX}${opts.keyPrefix}/${crypto.randomUUID()}.${ext}`;
    const uploadUrl = this.publicClient().file(key).presign({
      method: 'PUT',
      expiresIn: ttl,
      type: opts.contentType,
    });
    return {
      uploadUrl,
      key,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      requiredHeaders: {
        'content-type': opts.contentType,
        'content-length': String(opts.contentLength),
      },
    };
  }

  presignDownload(key: string, ttlSeconds: number = DEFAULT_DOWNLOAD_TTL_SECONDS): string {
    return this.publicClient().file(key).presign({
      method: 'GET',
      expiresIn: ttlSeconds,
    });
  }

  async read(key: string): Promise<Buffer> {
    const bytes = await this.serverClient().file(key).arrayBuffer();
    return Buffer.from(bytes);
  }

  async delete(key: string): Promise<void> {
    try {
      await this.serverClient().file(key).delete();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 404 / NoSuchKey is fine — concurrent delete or lifecycle sweep.
      if (message.includes('NoSuchKey') || message.includes('404')) return;
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

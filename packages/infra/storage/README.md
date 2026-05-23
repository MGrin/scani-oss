# @scani/storage

S3-compatible object-storage service. Uses Bun's native `S3Client`; works
against any S3-compatible backend — Cloudflare R2 in production, MinIO
in local dev, AWS S3 too if anyone ever needs it.

## Use case

Temporary job-payload storage. The frontend uploads large blobs
(screenshots, CSV files) via a presigned PUT URL, then passes the
returned key in a BullMQ job payload. Workers read the blob, process
it, delete on success — and a 24h bucket lifecycle rule sweeps `temp/`
to clean up orphans from failed jobs.

## What's exported

| Export | Purpose |
|---|---|
| `StorageService` (`@Service()`) | The class. Inject via typedi (`Container.get(StorageService)`). |
| `PresignUploadOptions` | `presignUpload` input. |
| `PresignedUpload` | `presignUpload` output: `uploadUrl`, `key`, `expiresAt`, `requiredHeaders`. |
| `HealthResult` | `healthCheck` output: `{ ok: true, latencyMs }` or `{ ok: false, error }`. |

## Methods

| Method | Purpose |
|---|---|
| `presignUpload(opts)` | Returns a presigned PUT URL under `temp/<keyPrefix>/<uuid>.<ext>`. Default TTL 15 min. |
| `presignDownload(key, ttlSeconds?)` | Presigned GET URL. Default TTL 5 min. |
| `read(key)` | Fetches the blob server-side as a `Buffer`. |
| `delete(key)` | Deletes the blob. 404 / `NoSuchKey` is silently swallowed (concurrent delete or lifecycle sweep). |
| `healthCheck()` | Signs a HEAD request against a non-existent key; treats 200/403/404 as healthy (see implementation comment for the rationale). Never throws. |

## Configuration

The service reads its config directly from `process.env` on first method
call — consumers don't pass it in. Apps that use `StorageService` simply
set the env vars below and call methods.

| Env var | Required | Purpose |
|---|---|---|
| `S3_ACCESS_KEY_ID` | yes | SigV4 access key. |
| `S3_SECRET_ACCESS_KEY` | yes | SigV4 secret. |
| `S3_BUCKET` | yes | Bucket name. |
| `S3_ENDPOINT` | yes | Server-side URL. For Cloudflare R2 use `https://<account_id>.r2.cloudflarestorage.com`. For MinIO local dev use `http://minio:9000` (in-network) or `http://localhost:9000` (host). |
| `S3_PUBLIC_ENDPOINT` | no | Browser-reachable URL baked into presigned URLs. Defaults to `S3_ENDPOINT`. Only different when the bucket is reachable on different addresses from server vs browser (typical local-dev MinIO setup). |
| `S3_REGION` | no | S3 region. Defaults to `auto` (R2/MinIO accept it; AWS S3 needs the real region). |

The schema is validated lazily — `requireConfig` runs on the first method
call. If any required var is missing or `S3_ENDPOINT` isn't a valid URL,
the call throws with a clear list of issues. This means processes that
don't actually use storage (e.g. an api running with `SCANI_CLOUD_URL`
set, where the cloud-client storage facade routes to the data-provider)
never fail boot for missing storage env.

## Usage

```ts
import { StorageService } from '@scani/storage';
import { Container } from 'typedi';

const storage = Container.get(StorageService);

const upload = storage.presignUpload({
  keyPrefix: 'screenshot',
  extension: 'png',
  contentType: 'image/png',
  contentLength: 524_288,
});
// upload.uploadUrl is a presigned PUT URL the browser can use directly.

const buf = await storage.read(upload.key);
await storage.delete(upload.key);
```

That's the entire integration: no `configure()` step, no env-shape
declarations in the host app's own zod schema. The host app's only job
is to make sure the `S3_*` vars are set before the first storage call.

## Why this package owns its env schema

Three apps used to declare `R2_*` vars in their own `env.ts`, with
matching values in `.env.example` and docker-compose.yml — and their
boot code each ran an identical "if env is set, configure storage"
block. That's three duplications of the same contract, and any drift
silently breaks one tier. Owning the env shape inside the package means:

- Apps add nothing to their env.ts.
- The contract for "what env vars storage needs" lives in one place.
- New backends (S3, GCS-via-S3-compat, …) only need a backend-specific
  README note — the env shape is already generic.

## Why two endpoints

`S3_ENDPOINT` is what the host service uses to talk to S3 directly
(server-to-server reads / writes / deletes). `S3_PUBLIC_ENDPOINT` is
what gets baked into presigned URLs that browsers will hit. They differ
when the bucket is reachable on different addresses from the server vs
the browser — the canonical example is local dev with MinIO at
`http://minio:9000` (compose network) and `http://localhost:9000`
(browser). When `S3_PUBLIC_ENDPOINT` is omitted it falls back to
`S3_ENDPOINT`.

## Security note

Bun's `presign` binds the `host` header into the SigV4 signature but not
`content-type` or `content-length`. The `requiredHeaders` returned from
`presignUpload` are advisory — callers should set them, but a malicious
client can ignore them. The real defences are upstream:

- Admission-time validation on the call site that issues the presign
  (allowlisted MIME types, size caps).
- The `temp/` prefix has a 24h bucket lifecycle policy, so leaked URLs
  produce orphan blobs that auto-expire.

## Backends tested

- Cloudflare R2 (production)
- MinIO (local dev via docker-compose, `localhost:9000`)
- Should also work against AWS S3 with `S3_REGION` set to the bucket's
  real region instead of the default `auto`.

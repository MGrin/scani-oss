import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { S3Client } from 'bun';
import {
  type HealthResult,
  isMissingObjectError,
  isObjectTooLargeError,
  type PresignUploadOptions,
  StorageService,
} from '../src/index';

interface S3FileCall {
  key: string;
  op: 'presign' | 'stream' | 'arrayBuffer' | 'delete' | 'write';
  presign?: { method: string; expiresIn: number; type?: string };
  // What `file(key, options)` was handed. `undefined` means no second
  // argument at all, which is NOT the same as `{ bucket: undefined }` —
  // the latter overrides the client's configured bucket with nothing.
  fileOptions?: { bucket?: string };
  writeType?: string;
}

interface FakeS3Options {
  deleteError?: string;
  bytes?: Uint8Array;
  label: string;
}

function buildFakeS3(opts: FakeS3Options): { sdk: S3Client; calls: S3FileCall[]; label: string } {
  const calls: S3FileCall[] = [];
  const sdk = {
    file: (key: string, fileOptions?: { bucket?: string }) => ({
      presign: (presign: { method: string; expiresIn: number; type?: string }) => {
        calls.push({ key, op: 'presign', presign, fileOptions });
        return `https://${opts.label}.example/${encodeURIComponent(key)}?ttl=${presign.expiresIn}&method=${presign.method}`;
      },
      stream: () => {
        calls.push({ key, op: 'stream', fileOptions });
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(opts.bytes ?? new Uint8Array([1, 2, 3]));
            controller.close();
          },
        });
      },
      arrayBuffer: async () => {
        calls.push({ key, op: 'arrayBuffer', fileOptions });
        return (opts.bytes ?? new Uint8Array([1, 2, 3])).buffer;
      },
      write: async (_bytes: Uint8Array, writeOpts?: { type?: string }) => {
        calls.push({ key, op: 'write', fileOptions, writeType: writeOpts?.type });
      },
      delete: async () => {
        calls.push({ key, op: 'delete', fileOptions });
        if (opts.deleteError) throw new Error(opts.deleteError);
      },
    }),
  };
  return { sdk: sdk as unknown as S3Client, calls, label: opts.label };
}

interface BuildArgs {
  serverDeleteError?: string;
  serverBytes?: Uint8Array;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  envOverride?: NodeJS.ProcessEnv;
}

const SERVER_ENDPOINT = 'https://internal.example';
const PUBLIC_ENDPOINT = 'https://public.example';

class TestStorageService extends StorageService {
  sdks: Array<ReturnType<typeof buildFakeS3>> = [];
  fetcherCalls: Array<{ url: string; init: RequestInit }> = [];
  private buildArgs: BuildArgs;

  constructor(args: BuildArgs = {}) {
    super();
    this.buildArgs = args;
  }

  protected env(): NodeJS.ProcessEnv {
    return this.buildArgs.envOverride ?? super.env();
  }

  protected override buildSdk(opts: Parameters<StorageService['buildSdk']>[0]): S3Client {
    const isServer = opts.endpoint === SERVER_ENDPOINT;
    const fake = buildFakeS3({
      label: opts.endpoint,
      deleteError: isServer ? this.buildArgs.serverDeleteError : undefined,
      bytes: isServer ? this.buildArgs.serverBytes : undefined,
    });
    this.sdks.push(fake);
    return fake.sdk;
  }

  protected fetcher(url: string, init: RequestInit): Promise<Response> {
    this.fetcherCalls.push({ url, init });
    if (this.buildArgs.fetcher) return this.buildArgs.fetcher(url, init);
    return fetch(url, init);
  }

  fakeFor(endpoint: string): ReturnType<typeof buildFakeS3> | undefined {
    return this.sdks.find((s) => s.label === endpoint);
  }
}

const validEnv: NodeJS.ProcessEnv = {
  S3_ACCESS_KEY_ID: 'AKIAxxxx',
  S3_SECRET_ACCESS_KEY: 'sk_xxx',
  S3_BUCKET: 'scani-jobs',
  S3_ENDPOINT: SERVER_ENDPOINT,
  S3_PUBLIC_ENDPOINT: PUBLIC_ENDPOINT,
};

// Snapshot every S3_* env var the schema reads so a test that mutates
// them via `envOverride` can be rerun without leaking into peers.
const SNAP_KEYS = [
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_BUCKET',
  'S3_ENDPOINT',
  'S3_PUBLIC_ENDPOINT',
  'S3_REGION',
] as const;
const snapshotEnv = (): Record<string, string | undefined> => {
  const snap: Record<string, string | undefined> = {};
  for (const k of SNAP_KEYS) snap[k] = process.env[k];
  return snap;
};
const restoreEnv = (snap: Record<string, string | undefined>): void => {
  for (const k of SNAP_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
};

let envSnap: Record<string, string | undefined>;
beforeEach(() => {
  envSnap = snapshotEnv();
  // Ensure tests start without ambient S3_* env so missing-config tests
  // see the truly-empty case regardless of the host shell.
  for (const k of SNAP_KEYS) delete process.env[k];
});
afterEach(() => {
  restoreEnv(envSnap);
});

describe('env validation', () => {
  test('every method throws when no S3_* env vars are set', () => {
    const svc = new TestStorageService();
    expect(() =>
      svc.presignUpload({
        keyPrefix: 'screenshot',
        extension: 'png',
        contentType: 'image/png',
        contentLength: 100,
      })
    ).toThrow(/StorageService env misconfigured/);

    expect(() => svc.presignDownload('key')).toThrow(/StorageService env misconfigured/);
    expect(svc.read('key')).rejects.toThrow(/StorageService env misconfigured/);
    expect(svc.delete('key')).rejects.toThrow(/StorageService env misconfigured/);
  });

  test('error message names the missing variables', () => {
    const svc = new TestStorageService({
      envOverride: { S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' },
    });
    expect(() => svc.presignDownload('key')).toThrow(/S3_BUCKET/);
    expect(() => svc.presignDownload('key')).toThrow(/S3_ENDPOINT/);
  });

  test('rejects an invalid S3_ENDPOINT URL', () => {
    const svc = new TestStorageService({
      envOverride: { ...validEnv, S3_ENDPOINT: 'not a url' },
    });
    expect(() => svc.presignDownload('key')).toThrow(/S3_ENDPOINT/);
  });

  test('S3_PUBLIC_ENDPOINT defaults to S3_ENDPOINT when omitted', () => {
    const svc = new TestStorageService({
      envOverride: { ...validEnv, S3_PUBLIC_ENDPOINT: undefined },
    });
    svc.presignDownload('key');
    // Server and public endpoints collapse to one fake.
    expect(svc.fakeFor(SERVER_ENDPOINT)).toBeDefined();
    expect(svc.fakeFor(PUBLIC_ENDPOINT)).toBeUndefined();
  });

  test('config is cached after first call (env mutations after that are ignored)', () => {
    const env: NodeJS.ProcessEnv = { ...validEnv };
    const svc = new TestStorageService({ envOverride: env });
    svc.presignDownload('first');
    expect(svc.sdks).toHaveLength(1); // public-only built lazily
    env.S3_BUCKET = 'something-else';
    svc.presignDownload('second');
    // No new SDK built — cached config means same publicSdk reused.
    expect(svc.sdks).toHaveLength(1);
  });

  test('fully valid env loads without throwing', () => {
    const svc = new TestStorageService({ envOverride: validEnv });
    expect(() => svc.presignDownload('key')).not.toThrow();
  });
});

describe('presignUpload', () => {
  test('the real signer binds the declared byte length and content type', async () => {
    class RealSignerStorage extends StorageService {
      protected override env() {
        return validEnv;
      }
    }
    const result = await new RealSignerStorage().presignUpload({
      keyPrefix: 'document/u1',
      extension: 'pdf',
      contentType: 'application/pdf',
      contentLength: 123,
    });
    expect(new URL(result.uploadUrl).searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual([
      'content-length',
      'content-type',
      'host',
    ]);
  });

  function defaultOpts(): PresignUploadOptions {
    return {
      keyPrefix: 'screenshot',
      extension: 'png',
      contentType: 'image/png',
      contentLength: 524_288,
    };
  }

  function svcWithEnv(): TestStorageService {
    return new TestStorageService({ envOverride: validEnv });
  }

  test('uses the public endpoint, not the server endpoint', async () => {
    const svc = svcWithEnv();
    const result = await svc.presignUpload(defaultOpts());
    expect(new URL(result.uploadUrl).origin).toBe(PUBLIC_ENDPOINT);
    expect(svc.fakeFor(SERVER_ENDPOINT)).toBeUndefined();
  });

  test('builds keys under temp/<keyPrefix>/<uuid>.<ext>', async () => {
    const svc = svcWithEnv();
    const result = await svc.presignUpload(defaultOpts());
    expect(result.key).toMatch(/^temp\/screenshot\/[0-9a-f-]{36}\.png$/);
  });

  test('strips a leading dot from extension', async () => {
    const svc = svcWithEnv();
    const result = await svc.presignUpload({ ...defaultOpts(), extension: '.csv' });
    expect(result.key).toMatch(/\.csv$/);
    expect(result.key).not.toMatch(/\.\.csv$/);
  });

  test('returns content-type + content-length in requiredHeaders', async () => {
    const svc = svcWithEnv();
    const result = await svc.presignUpload({ ...defaultOpts(), contentLength: 12_345 });
    expect(result.requiredHeaders).toEqual({
      'content-type': 'image/png',
      'content-length': '12345',
    });
  });

  test('respects ttlSeconds and reflects it in expiresAt', async () => {
    const svc = svcWithEnv();
    const before = Date.now();
    const result = await svc.presignUpload({ ...defaultOpts(), ttlSeconds: 60 });
    const after = Date.now();
    const expiresAt = Date.parse(result.expiresAt);
    expect(new URL(result.uploadUrl).searchParams.get('X-Amz-Expires')).toBe('60');
    expect(expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(expiresAt).toBeLessThanOrEqual(after + 60_000);
  });

  test('default TTL is 15 minutes', async () => {
    const svc = svcWithEnv();
    const before = Date.now();
    const result = await svc.presignUpload(defaultOpts());
    const expiresAt = Date.parse(result.expiresAt);
    expect(expiresAt - before).toBeGreaterThanOrEqual(15 * 60 * 1000 - 50);
  });

  test('two consecutive uploads produce different keys (uuid is random)', async () => {
    const svc = svcWithEnv();
    const a = await svc.presignUpload(defaultOpts());
    const b = await svc.presignUpload(defaultOpts());
    expect(a.key).not.toBe(b.key);
  });

  test('rejects keyPrefix containing path traversal', async () => {
    const svc = svcWithEnv();
    expect(() => svc.presignUpload({ ...defaultOpts(), keyPrefix: '../etc/passwd' })).toThrow(
      /invalid keyPrefix/i
    );
    expect(() => svc.presignUpload({ ...defaultOpts(), keyPrefix: 'a/../b' })).toThrow(
      /invalid keyPrefix/i
    );
  });

  test('rejects keyPrefix with leading / trailing / double slash', async () => {
    const svc = svcWithEnv();
    expect(() => svc.presignUpload({ ...defaultOpts(), keyPrefix: '/screenshot' })).toThrow();
    expect(() => svc.presignUpload({ ...defaultOpts(), keyPrefix: 'screenshot/' })).toThrow();
    expect(() => svc.presignUpload({ ...defaultOpts(), keyPrefix: 'a//b' })).toThrow();
  });

  test('rejects keyPrefix longer than 200 chars', async () => {
    const svc = svcWithEnv();
    const huge = 'a'.repeat(201);
    expect(() => svc.presignUpload({ ...defaultOpts(), keyPrefix: huge })).toThrow();
  });

  test('rejects extension with non-alphanumeric characters', async () => {
    const svc = svcWithEnv();
    expect(() => svc.presignUpload({ ...defaultOpts(), extension: 'png/foo' })).toThrow(
      /invalid extension/i
    );
    expect(() => svc.presignUpload({ ...defaultOpts(), extension: '..' })).toThrow(
      /invalid extension/i
    );
  });

  test('accepts a multi-segment alphanumeric keyPrefix', async () => {
    const svc = svcWithEnv();
    const result = await svc.presignUpload({ ...defaultOpts(), keyPrefix: 'screenshot/user-123' });
    expect(result.key).toMatch(/^temp\/screenshot\/user-123\/[0-9a-f-]{36}\.png$/);
  });
});

describe('presignDownload', () => {
  function svcWithEnv(): TestStorageService {
    return new TestStorageService({ envOverride: validEnv });
  }

  test('uses the public endpoint with method=GET', () => {
    const svc = svcWithEnv();
    svc.presignDownload('temp/foo/abc.png');
    const publicFake = svc.fakeFor(PUBLIC_ENDPOINT);
    const presignCall = publicFake?.calls.find(
      (c) => c.op === 'presign' && c.key === 'temp/foo/abc.png'
    );
    expect(presignCall?.presign?.method).toBe('GET');
  });

  test('default TTL is 5 minutes', () => {
    const svc = svcWithEnv();
    svc.presignDownload('key');
    const publicFake = svc.fakeFor(PUBLIC_ENDPOINT);
    expect(publicFake?.calls.find((c) => c.op === 'presign')?.presign?.expiresIn).toBe(300);
  });

  test('respects an explicit TTL', () => {
    const svc = svcWithEnv();
    svc.presignDownload('key', 30);
    const publicFake = svc.fakeFor(PUBLIC_ENDPOINT);
    expect(publicFake?.calls.find((c) => c.op === 'presign')?.presign?.expiresIn).toBe(30);
  });
});

describe('read', () => {
  test('returns a Buffer of the underlying bytes', async () => {
    const bytes = new Uint8Array([10, 20, 30, 40, 50]);
    const svc = new TestStorageService({ envOverride: validEnv, serverBytes: bytes });
    const buf = await svc.read('some-key');
    expect(buf).toBeInstanceOf(Buffer);
    expect(Array.from(buf)).toEqual([10, 20, 30, 40, 50]);
  });

  test('reads via the server endpoint, not the public one', async () => {
    const svc = new TestStorageService({ envOverride: validEnv });
    await svc.read('some-key');
    expect(svc.fakeFor(SERVER_ENDPOINT)).toBeDefined();
    expect(svc.fakeFor(PUBLIC_ENDPOINT)).toBeUndefined();
  });
});

describe('delete', () => {
  test('forwards to the server SDK', async () => {
    const svc = new TestStorageService({ envOverride: validEnv });
    await svc.delete('temp/foo/bar.png');
    const serverFake = svc.fakeFor(SERVER_ENDPOINT);
    expect(serverFake?.calls.some((c) => c.op === 'delete' && c.key === 'temp/foo/bar.png')).toBe(
      true
    );
  });

  test('swallows NoSuchKey errors', async () => {
    const svc = new TestStorageService({
      envOverride: validEnv,
      serverDeleteError: 'NoSuchKey: ...',
    });
    await expect(svc.delete('key')).resolves.toBeUndefined();
  });

  test('swallows 404 errors', async () => {
    const svc = new TestStorageService({
      envOverride: validEnv,
      serverDeleteError: 'http 404 not found',
    });
    await expect(svc.delete('key')).resolves.toBeUndefined();
  });

  test('propagates other errors', async () => {
    const svc = new TestStorageService({
      envOverride: validEnv,
      serverDeleteError: '500 internal server error',
    });
    await expect(svc.delete('key')).rejects.toThrow(/500/);
  });
});

describe('healthCheck', () => {
  function svcWithStatus(status: number): TestStorageService {
    return new TestStorageService({
      envOverride: validEnv,
      fetcher: async () => new Response(null, { status }),
    });
  }

  test.each([200, 403, 404])('treats status %s as healthy', async (status) => {
    const svc = svcWithStatus(status);
    const result = await svc.healthCheck();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test.each([401, 500, 503])('treats status %s as unhealthy', async (status) => {
    const svc = svcWithStatus(status);
    const result = await svc.healthCheck();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(`unexpected status ${status}`);
  });

  test('reports a fetch failure as ok=false', async () => {
    const svc = new TestStorageService({
      envOverride: validEnv,
      fetcher: async () => {
        throw new Error('socket hang up');
      },
    });
    const result: HealthResult = await svc.healthCheck();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('socket hang up');
  });

  test('uses HEAD against a __healthcheck__ key', async () => {
    const svc = svcWithStatus(404);
    await svc.healthCheck();
    const lastFetch = svc.fetcherCalls.at(-1);
    expect(lastFetch?.init.method).toBe('HEAD');
    expect(lastFetch?.url).toContain('__healthcheck__');
  });

  test('does not throw when env is missing (returns ok=false)', async () => {
    const svc = new TestStorageService();
    const result = await svc.healthCheck();
    expect(result.ok).toBe(false);
  });
});

/**
 * SC-793. The nightly `db-backup` job writes to the archive bucket while
 * everything else keeps writing to the job-uploads one, so `write`/`read` take
 * a per-call bucket. It is per-call and not a second configured client on
 * purpose: moving the default is what would make an unrelated upload land in a
 * bucket nobody is looking at.
 */
describe('per-call bucket override', () => {
  /**
   * `test-bucket` IS A FIXTURE AND MUST STAY ONE (SC-1112). This block named a
   * real bucket, and nothing in it depended on that: every assertion here is
   * that whatever key and bucket the caller passes arrive on `fileOptions`
   * unchanged, which any two strings establish.
   *
   * The reason to say so is the shape of this file rather than the value. It is
   * `oss-eligible`, present upstream and drifted, so the ordinary repair —
   * converge it — is the one act that publishes whatever the private half
   * carries. And no guard would have stopped it: run from a mirror checkout
   * against these exact added lines, `check-oss-data-shapes`, `check-oss-figures`,
   * `check-oss-prose` and `check-oss-internal-refs` all PASS on real
   * denominators, because a bucket is a NAME and the identifier rules read
   * shapes. The scanner says as much in its own refusal text.
   */
  test('write targets the named bucket', async () => {
    const svc = new TestStorageService({ envOverride: validEnv });
    await svc.write('archive-fixture.dump', new Uint8Array([9]), 'application/octet-stream', {
      bucket: 'test-bucket',
    });

    const call = svc.fakeFor(SERVER_ENDPOINT)?.calls.find((c) => c.op === 'write');
    expect(call?.fileOptions).toEqual({ bucket: 'test-bucket' });
    expect(call?.writeType).toBe('application/octet-stream');
  });

  test('read targets the named bucket', async () => {
    const svc = new TestStorageService({ envOverride: validEnv });
    await svc.read('archive-fixture.dump', { bucket: 'test-bucket' });

    const call = svc.fakeFor(SERVER_ENDPOINT)?.calls.find((c) => c.op === 'arrayBuffer');
    expect(call?.fileOptions).toEqual({ bucket: 'test-bucket' });
  });

  /**
   * must-be-ABSENT control. Handing Bun's S3Client `{ bucket: undefined }`
   * overrides the configured bucket with nothing rather than leaving it alone,
   * so an override helper that always passes an object breaks every existing
   * caller — silently, because the failure is a 404 on a bucket-less URL.
   */
  test('no override passes NO options object, not one holding undefined', async () => {
    const svc = new TestStorageService({ envOverride: validEnv });
    await svc.write('icons/a.png', new Uint8Array([1]), 'image/png');
    await svc.read('icons/a.png');

    for (const call of svc.fakeFor(SERVER_ENDPOINT)?.calls ?? []) {
      expect(call.fileOptions).toBeUndefined();
    }
  });

  test('an empty-string bucket is treated as no override', async () => {
    const svc = new TestStorageService({ envOverride: validEnv });
    await svc.write('icons/a.png', new Uint8Array([1]), 'image/png', { bucket: '' });

    expect(
      svc.fakeFor(SERVER_ENDPOINT)?.calls.find((c) => c.op === 'write')?.fileOptions
    ).toBeUndefined();
  });
});

// SC-1345: a presigned PUT does not bind its size, so the only size an upload
// is known to have is the one storage reports. A capped read asks first, and
// refuses before a single byte of the body is pulled into memory.
describe('read with maxBytes', () => {
  test('rejects a replacement body larger than its earlier HEAD', async () => {
    const svc = new TestStorageService({
      envOverride: validEnv,
      serverBytes: new Uint8Array(16),
      fetcher: async () => new Response(null, { status: 200, headers: { 'content-length': '4' } }),
    });
    await expect(svc.read('temp/file-import/u1/a.csv', { maxBytes: 8 })).rejects.toMatchObject({
      name: 'ObjectTooLargeError',
    });
  });

  const head = (status: number, headers: Record<string, string> = {}) => ({
    envOverride: validEnv,
    fetcher: async () => new Response(null, { status, headers }),
  });
  const bodyReads = (svc: TestStorageService) =>
    (svc.fakeFor(SERVER_ENDPOINT)?.calls ?? []).filter(
      (c) => c.op === 'arrayBuffer' || c.op === 'stream'
    );

  test('an object over the cap is refused before its body is read', async () => {
    const svc = new TestStorageService(head(200, { 'content-length': '8388609' }));
    const err = await svc.read('temp/file-import/u1/a.csv', { maxBytes: 8388608 }).catch((e) => e);
    expect(isObjectTooLargeError(err)).toBe(true);
    expect(isMissingObjectError(err)).toBe(false);
    expect(bodyReads(svc)).toEqual([]);
    expect(svc.fetcherCalls[0]?.init.method).toBe('HEAD');
  });

  test('an object at the cap is read', async () => {
    const svc = new TestStorageService({
      ...head(200, { 'content-length': '3' }),
      serverBytes: new Uint8Array([7, 8, 9]),
    });
    const buf = await svc.read('temp/file-import/u1/a.csv', { maxBytes: 3 });
    expect([...buf]).toEqual([7, 8, 9]);
    expect(bodyReads(svc)).toHaveLength(1);
  });

  test('a size storage will not state is refused, not guessed', async () => {
    const svc = new TestStorageService(head(200));
    const err = await svc.read('temp/file-import/u1/a.csv', { maxBytes: 10 }).catch((e) => e);
    expect(isObjectTooLargeError(err)).toBe(true);
    expect(bodyReads(svc)).toEqual([]);
  });

  test('a missing object still reads as missing', async () => {
    const svc = new TestStorageService(head(404));
    const err = await svc.read('temp/file-import/u1/a.csv', { maxBytes: 10 }).catch((e) => e);
    expect(isMissingObjectError(err)).toBe(true);
    expect(bodyReads(svc)).toEqual([]);
  });

  test('without a cap the read is unchanged: no HEAD first', async () => {
    const svc = new TestStorageService({ envOverride: validEnv });
    await svc.read('temp/file-import/u1/a.csv');
    expect(svc.fetcherCalls).toEqual([]);
    expect(bodyReads(svc)).toHaveLength(1);
  });
});

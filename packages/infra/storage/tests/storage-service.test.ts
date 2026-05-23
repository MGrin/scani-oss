import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { S3Client } from 'bun';
import { type HealthResult, type PresignUploadOptions, StorageService } from '../src/index';

interface S3FileCall {
  key: string;
  op: 'presign' | 'arrayBuffer' | 'delete';
  presign?: { method: string; expiresIn: number; type?: string };
}

interface FakeS3Options {
  deleteError?: string;
  bytes?: Uint8Array;
  label: string;
}

function buildFakeS3(opts: FakeS3Options): { sdk: S3Client; calls: S3FileCall[]; label: string } {
  const calls: S3FileCall[] = [];
  const sdk = {
    file: (key: string) => ({
      presign: (presign: { method: string; expiresIn: number; type?: string }) => {
        calls.push({ key, op: 'presign', presign });
        return `https://${opts.label}.example/${encodeURIComponent(key)}?ttl=${presign.expiresIn}&method=${presign.method}`;
      },
      arrayBuffer: async () => {
        calls.push({ key, op: 'arrayBuffer' });
        return (opts.bytes ?? new Uint8Array([1, 2, 3])).buffer;
      },
      delete: async () => {
        calls.push({ key, op: 'delete' });
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

  protected buildSdk(opts: { endpoint: string } & Record<string, unknown>): S3Client {
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

  test('uses the public endpoint, not the server endpoint', () => {
    const svc = svcWithEnv();
    svc.presignUpload(defaultOpts());
    const publicFake = svc.fakeFor(PUBLIC_ENDPOINT);
    expect(publicFake?.calls.some((c) => c.op === 'presign' && c.presign?.method === 'PUT')).toBe(
      true
    );
    expect(svc.fakeFor(SERVER_ENDPOINT)).toBeUndefined();
  });

  test('builds keys under temp/<keyPrefix>/<uuid>.<ext>', () => {
    const svc = svcWithEnv();
    const result = svc.presignUpload(defaultOpts());
    expect(result.key).toMatch(/^temp\/screenshot\/[0-9a-f-]{36}\.png$/);
  });

  test('strips a leading dot from extension', () => {
    const svc = svcWithEnv();
    const result = svc.presignUpload({ ...defaultOpts(), extension: '.csv' });
    expect(result.key).toMatch(/\.csv$/);
    expect(result.key).not.toMatch(/\.\.csv$/);
  });

  test('returns content-type + content-length in requiredHeaders', () => {
    const svc = svcWithEnv();
    const result = svc.presignUpload({ ...defaultOpts(), contentLength: 12_345 });
    expect(result.requiredHeaders).toEqual({
      'content-type': 'image/png',
      'content-length': '12345',
    });
  });

  test('respects ttlSeconds and reflects it in expiresAt', () => {
    const svc = svcWithEnv();
    const before = Date.now();
    const result = svc.presignUpload({ ...defaultOpts(), ttlSeconds: 60 });
    const expiresAt = Date.parse(result.expiresAt);
    expect(expiresAt - before).toBeGreaterThanOrEqual(60_000 - 50);
    expect(expiresAt - before).toBeLessThanOrEqual(60_000 + 50);
  });

  test('default TTL is 15 minutes', () => {
    const svc = svcWithEnv();
    const before = Date.now();
    const result = svc.presignUpload(defaultOpts());
    const expiresAt = Date.parse(result.expiresAt);
    expect(expiresAt - before).toBeGreaterThanOrEqual(15 * 60 * 1000 - 50);
  });

  test('two consecutive uploads produce different keys (uuid is random)', () => {
    const svc = svcWithEnv();
    const a = svc.presignUpload(defaultOpts());
    const b = svc.presignUpload(defaultOpts());
    expect(a.key).not.toBe(b.key);
  });

  test('rejects keyPrefix containing path traversal', () => {
    const svc = svcWithEnv();
    expect(() => svc.presignUpload({ ...defaultOpts(), keyPrefix: '../etc/passwd' })).toThrow(
      /invalid keyPrefix/i
    );
    expect(() => svc.presignUpload({ ...defaultOpts(), keyPrefix: 'a/../b' })).toThrow(
      /invalid keyPrefix/i
    );
  });

  test('rejects keyPrefix with leading / trailing / double slash', () => {
    const svc = svcWithEnv();
    expect(() => svc.presignUpload({ ...defaultOpts(), keyPrefix: '/screenshot' })).toThrow();
    expect(() => svc.presignUpload({ ...defaultOpts(), keyPrefix: 'screenshot/' })).toThrow();
    expect(() => svc.presignUpload({ ...defaultOpts(), keyPrefix: 'a//b' })).toThrow();
  });

  test('rejects keyPrefix longer than 200 chars', () => {
    const svc = svcWithEnv();
    const huge = 'a'.repeat(201);
    expect(() => svc.presignUpload({ ...defaultOpts(), keyPrefix: huge })).toThrow();
  });

  test('rejects extension with non-alphanumeric characters', () => {
    const svc = svcWithEnv();
    expect(() => svc.presignUpload({ ...defaultOpts(), extension: 'png/foo' })).toThrow(
      /invalid extension/i
    );
    expect(() => svc.presignUpload({ ...defaultOpts(), extension: '..' })).toThrow(
      /invalid extension/i
    );
  });

  test('accepts a multi-segment alphanumeric keyPrefix', () => {
    const svc = svcWithEnv();
    const result = svc.presignUpload({ ...defaultOpts(), keyPrefix: 'screenshot/user-123' });
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

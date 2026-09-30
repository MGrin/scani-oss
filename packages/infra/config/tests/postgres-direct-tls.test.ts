import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import tls from 'node:tls';
import { postgresJsTls as tlsFor } from '../src/postgres-direct-tls';
import { postgresJsSsl } from '../src/postgres-tls';

const postgresJsTls = (url: string) => tlsFor(url, postgresJsSsl(url));

const NEON = 'postgresql://u:p@ep-x.aws.neon.tech/neondb?channel_binding=require&sslmode=require';

describe('SC-1440 — postgres.js opens TLS directly where the server allows it', () => {
  let spy: ReturnType<typeof spyOn> | null = null;
  afterEach(() => spy?.mockRestore());

  test('a Neon URL gets a direct-TLS socket and no in-band upgrade', () => {
    const t = postgresJsTls(NEON);
    expect(t.ssl).toBe(false);
    expect(typeof t.socket).toBe('function');
  });

  test('sslnegotiation=direct opts any other host in', () => {
    expect(typeof postgresJsTls('postgres://u:p@db.example/x?sslnegotiation=direct').socket).toBe(
      'function'
    );
  });

  test('CONTROL: a hosted non-Neon server keeps the SSLRequest upgrade, since direct needs Postgres 17', () => {
    const t = postgresJsTls('postgres://u:p@db.example/x?sslmode=require');
    expect(t.ssl).toBe('verify-full');
    expect(t.socket).toBeUndefined();
  });

  test('CONTROL: the compose Postgres and loopback stay plaintext', () => {
    expect(postgresJsTls('postgres://u:p@postgres:5432/x?sslmode=disable')).toEqual({ ssl: false });
    expect(postgresJsTls('postgres://u:p@localhost:5433/x')).toEqual({ ssl: false });
  });

  test('a multi-host URL keeps the upgrade, since the socket hook cannot see which host is being tried', () => {
    expect(postgresJsTls('postgres://u:p@a.neon.tech,b.neon.tech/x').socket).toBeUndefined();
  });

  test('the direct socket still verifies: SNI set, postgresql ALPN, certificate checking left on', async () => {
    let seen: tls.ConnectionOptions | undefined;
    spy = spyOn(tls, 'connect').mockImplementation(((opts: tls.ConnectionOptions) => {
      seen = opts;
      const fake = Object.assign(new EventEmitter(), { destroy: () => {} });
      queueMicrotask(() => fake.emit('error', new Error('stub')));
      return fake;
    }) as never);
    const { socket } = postgresJsTls(NEON);
    await expect(socket?.({ host: ['ep-x.aws.neon.tech'], port: [5432] })).rejects.toThrow('stub');
    expect(seen?.host).toBe('ep-x.aws.neon.tech');
    expect(seen?.servername).toBe('ep-x.aws.neon.tech');
    expect(seen?.ALPNProtocols).toEqual(['postgresql']);
    expect(seen?.rejectUnauthorized).not.toBe(false);
  });
});

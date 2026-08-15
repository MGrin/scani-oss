import { describe, expect, it } from 'bun:test';
import {
  decideTarget,
  describeTarget,
  formatTarget,
  isLoopbackHost,
  parseAllowRemote,
  refusalMessage,
} from '../src/migrate-target';

const LOCAL = 'postgres://scani:scani@localhost:5433/scani?sslmode=disable';
const NEON = 'postgres://neondb_owner:hunter2@ep-cool-1234.us-east-2.aws.neon.tech/neondb';

describe('describeTarget', () => {
  it('reads host, port, database and user out of a connection string', () => {
    expect(describeTarget(LOCAL)).toEqual({
      host: 'localhost',
      port: '5433',
      database: 'scani',
      user: 'scani',
    });
  });

  it('defaults the port to 5432 when the URL omits it', () => {
    expect(describeTarget(NEON)?.port).toBe('5432');
  });

  it('returns null for a value that is not a connection URL', () => {
    expect(describeTarget('not a url')).toBeNull();
    expect(describeTarget('')).toBeNull();
  });

  it('never carries the password into the printable form', () => {
    const target = describeTarget(NEON);
    expect(target).not.toBeNull();
    expect(formatTarget(target as NonNullable<typeof target>)).toBe(
      'neondb_owner@ep-cool-1234.us-east-2.aws.neon.tech:5432/neondb'
    );
    expect(formatTarget(target as NonNullable<typeof target>)).not.toContain('hunter2');
  });
});

describe('isLoopbackHost', () => {
  it.each([
    'localhost',
    'LOCALHOST',
    '127.0.0.1',
    '127.0.0.53',
    '::1',
    '[::1]',
    'host.docker.internal',
  ])('treats %s as loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each([
    'postgres',
    'db',
    '10.0.0.4',
    '192.168.1.5',
    'ep-cool-1234.us-east-2.aws.neon.tech',
  ])('does not treat %s as loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('parseAllowRemote', () => {
  it('returns null when the flag is absent', () => {
    expect(parseAllowRemote(['bun', 'src/migrate.ts'])).toBeNull();
  });

  it('reads the space-separated form', () => {
    expect(parseAllowRemote(['bun', 'src/migrate.ts', '--allow-remote', 'db.example.com'])).toBe(
      'db.example.com'
    );
  });

  it('reads the equals form', () => {
    expect(parseAllowRemote(['--allow-remote=db.example.com'])).toBe('db.example.com');
  });

  it('returns an empty string when the flag has no value', () => {
    expect(parseAllowRemote(['bun', 'src/migrate.ts', '--allow-remote'])).toBe('');
  });
});

describe('decideTarget', () => {
  const local = describeTarget(LOCAL) as NonNullable<ReturnType<typeof describeTarget>>;
  const remote = describeTarget(NEON) as NonNullable<ReturnType<typeof describeTarget>>;

  it('lets a loopback target through with no flag at all', () => {
    expect(decideTarget(local, ['bun', 'src/migrate.ts'])).toEqual({
      allowed: true,
      reason: 'loopback',
    });
  });

  it('refuses a non-local target when nothing names it', () => {
    expect(decideTarget(remote, ['bun', 'src/migrate.ts'])).toEqual({
      allowed: false,
      requested: null,
    });
  });

  it('allows a non-local target whose host is named on the command line', () => {
    expect(decideTarget(remote, ['bun', 'src/migrate.ts', '--allow-remote', remote.host])).toEqual({
      allowed: true,
      reason: 'named',
    });
  });

  // The point of naming the host rather than passing a boolean: an operator who
  // believes they are pointed at a scratch database and is not gets stopped.
  it('refuses when the named host is not the host in DATABASE_URL', () => {
    expect(
      decideTarget(remote, ['bun', 'src/migrate.ts', '--allow-remote', 'ep-scratch.neon.tech'])
    ).toEqual({ allowed: false, requested: 'ep-scratch.neon.tech' });
  });

  it('refuses a bare --allow-remote with no host', () => {
    expect(decideTarget(remote, ['bun', 'src/migrate.ts', '--allow-remote'])).toEqual({
      allowed: false,
      requested: '',
    });
  });

  // An environment variable is exactly what the gate exists to not honour: it
  // can be left armed in a shell across many unrelated commands.
  it('ignores an environment-style opt-in that never reaches argv', () => {
    expect(decideTarget(remote, ['bun', 'src/migrate.ts'])).toEqual({
      allowed: false,
      requested: null,
    });
  });
});

describe('refusalMessage', () => {
  const remote = describeTarget(NEON) as NonNullable<ReturnType<typeof describeTarget>>;

  it('shows the target and the exact command that would allow it', () => {
    const message = refusalMessage(remote, null);
    expect(message).toContain('neondb_owner@ep-cool-1234.us-east-2.aws.neon.tech:5432/neondb');
    expect(message).toContain(`bun run db:migrate -- --allow-remote ${remote.host}`);
    expect(message).not.toContain('hunter2');
  });

  it('calls out a mismatch explicitly', () => {
    expect(refusalMessage(remote, 'ep-scratch.neon.tech')).toContain(
      '--allow-remote ep-scratch.neon.tech does not name that host'
    );
  });
});

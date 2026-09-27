import { expect, test } from 'bun:test';

test.each(['true', 'false'])(
  'the exported logger redacts inputs and child bindings with pretty=%s',
  (pretty) => {
    const source = new URL('../src/logger.ts', import.meta.url).pathname;
    const result = Bun.spawnSync(
      [
        process.execPath,
        '-e',
        `
    import { logger } from ${JSON.stringify(source)};
    const input = { credentials: { apiKey: 'SYNTHETIC-INPUT-SECRET' }, symbol: 'VISIBLE-CONTROL' };
    logger.child({ component: 'redaction-child', apiKey: 'SYNTHETIC-CHILD-SECRET' }).info({ input, error: new Error('error-control') }, 'pretty-control');
    if (input.credentials.apiKey !== 'SYNTHETIC-INPUT-SECRET') throw new Error('caller mutated');
  `,
      ],
      { env: { ...process.env, NODE_ENV: 'development', LOG_PRETTY: pretty, LOG_LEVEL: 'info' } }
    );
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString();
    expect(output).toContain('pretty-control');
    expect(output).toContain('VISIBLE-CONTROL');
    expect(output).toContain('error-control');
    expect(output).toContain('[redacted]');
    expect(output).not.toContain('SYNTHETIC-INPUT-SECRET');
    expect(output).not.toContain('SYNTHETIC-CHILD-SECRET');
  }
);

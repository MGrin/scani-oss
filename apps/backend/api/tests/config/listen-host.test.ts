import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

/**
 * The api listens where `HOST` says (SC-1674).
 *
 * `app.listen(PORT)` dropped `HOST`, so Bun bound its default, `::`, on every
 * machine: a dev api set to 127.0.0.1 was reachable from the LAN. Production
 * depends on that same `::`: data-provider reaches the api at
 * `scani-backend.internal:8080`, which is IPv6 over Fly 6PN, and `0.0.0.0`
 * binds IPv4 only. So the deployed `HOST` is `::`, which is exactly what
 * every deployment bound before this fix.
 */
const ROOT = resolve(import.meta.dir, '../../../../..');
const read = (path: string) => Bun.file(resolve(ROOT, path)).text();

describe('the api listen address', () => {
  test('HOST reaches listen', async () => {
    const source = await read('apps/backend/api/src/index.ts');
    expect(source).toMatch(/app\.listen\(\s*\{\s*port:\s*PORT,\s*hostname:\s*HOST\s*\}/);
    // The control: the defect's own shape is gone.
    expect(source).not.toMatch(/app\.listen\(\s*PORT\s*,/);
  });

  test.each([
    ['apps/backend/api/fly.toml', /^\s*HOST\s*=\s*"::"\s*$/m],
    ['infra/demo/fly.api.toml', /^\s*HOST\s*=\s*"::"\s*$/m],
    ['apps/backend/api/Dockerfile', /^\s*HOST=::\s*$/m],
  ])('%s deploys on ::, which keeps 6PN reachable', async (path, pattern) => {
    expect(await read(path)).toMatch(pattern);
  });

  test('an unset HOST still binds :: as before', async () => {
    expect(await read('apps/backend/api/src/config/env.ts')).toMatch(
      /HOST:\s*z\.string\(\)\.default\('::'\)/
    );
  });
});

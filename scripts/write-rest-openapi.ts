/**
 * Writes the committed OpenAPI document for `/api/v1` (SC-1648) from the code.
 * `apps/backend/api/tests/rest/rest-openapi.test.ts` fails when the two
 * differ, and says whether the difference only adds or needs `/api/v2`.
 *
 *   bun scripts/write-rest-openapi.ts
 *
 * It formats what it writes itself, so the one command works in this repo and
 * in the mirror, whose root `package.json` carries no `api:openapi` alias.
 */
import path from 'node:path';
import { buildRestOpenApi } from '../apps/backend/api/src/rest/openapi';

const target = path.join(import.meta.dir, '../apps/backend/api/src/rest/openapi.v1.json');
await Bun.write(target, `${JSON.stringify(buildRestOpenApi(), null, 2)}\n`);
const format = Bun.spawnSync(['bunx', 'biome', 'format', '--write', target], {
  stdio: ['ignore', 'inherit', 'inherit'],
});
if (format.exitCode !== 0) throw new Error(`biome format exited ${format.exitCode} on ${target}`);
console.log(`wrote ${path.relative(process.cwd(), target)}`);

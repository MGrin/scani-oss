// Import order matters: env side-effects MUST run before the router graph loads.
import './openapi-env';

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildOpenApiDoc } from '../src/openapi/build-doc';
import { mobileContractRouter } from '../src/openapi/mobile-contract-router';

const OUT_PATH = path.join(import.meta.dir, '..', 'openapi', 'scani-openapi.json');

function serialize(): string {
  return `${JSON.stringify(buildOpenApiDoc(mobileContractRouter), null, 2)}\n`;
}

function main(): void {
  const next = serialize();
  const isCheck = process.argv.includes('--check');

  if (isCheck) {
    let current = '';
    try {
      current = readFileSync(OUT_PATH, 'utf8');
    } catch {
      current = '';
    }
    if (current !== next) {
      console.error('❌ OpenAPI spec out of sync with the tRPC router. Run: bun run openapi:gen');
      process.exit(1);
    }
    console.log('✓ OpenAPI spec in sync');
    return;
  }

  writeFileSync(OUT_PATH, next);
  console.log(`✓ Wrote ${path.relative(process.cwd(), OUT_PATH)}`);
}

main();

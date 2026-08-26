// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings below are
// shell parameter expansions from a bash script, quoted verbatim so the assertion
// fails if the script's text changes. They are not TypeScript templates.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// `scripts/self-host.sh` and `docker-compose.prod.yml` have a contract nothing
// else checks: the compose file names the variables it refuses to start
// without, and the script is the only thing that produces them. Neither file
// imports the other, so the two drift silently — a `${NEW_SECRET:?}` added to
// the compose file breaks every self-host install at interpolation time, and
// the person who added it sees a green type-check and a green test suite.
//
// This is a text contract, so the test reads text. It is deliberately not an
// integration test: booting the stack takes minutes and needs Docker, and the
// failure this guards is a missing line, not a runtime behaviour.

const ROOT = resolve(import.meta.dir, '..', '..');
const COMPOSE = readFileSync(resolve(ROOT, 'docker-compose.prod.yml'), 'utf8');
const SCRIPT = readFileSync(resolve(ROOT, 'scripts', 'self-host.sh'), 'utf8');

function requiredVariables(compose: string): string[] {
  const found = new Set<string>();
  for (const match of compose.matchAll(/\$\{([A-Z0-9_]+):\?/g)) {
    const name = match[1];
    if (name) found.add(name);
  }
  return [...found].sort();
}

// Only the heredoc that produces .env counts. A variable merely mentioned in a
// comment or read back with grep is not a variable the operator receives.
function generatedVariables(script: string): string[] {
  const body = script.split('cat > .env <<ENV')[1]?.split('\nENV\n')[0];
  if (body === undefined) {
    throw new Error('scripts/self-host.sh no longer writes .env from a `cat > .env <<ENV` heredoc');
  }
  const found = new Set<string>();
  for (const line of body.split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (match?.[1]) found.add(match[1]);
  }
  return [...found].sort();
}

describe('self-host.sh generates what docker-compose.prod.yml demands', () => {
  test('the compose file still declares required variables', () => {
    // If this drops to zero the regex stopped matching, and every other
    // assertion here would pass vacuously.
    expect(requiredVariables(COMPOSE).length).toBeGreaterThan(0);
  });

  test('every ${VAR:?} in the compose file is written to .env', () => {
    const generated = new Set(generatedVariables(SCRIPT));
    const missing = requiredVariables(COMPOSE).filter((name) => !generated.has(name));
    expect(missing).toEqual([]);
  });

  test('the shared data-provider bearer is written as one value under both names', () => {
    // DATA_PROVIDER_API_KEY and SCANI_CLOUD_API_KEY must match byte for byte —
    // they are the two ends of the same bearer. Generating each with its own
    // `openssl rand` call produces two valid-looking secrets and an api that
    // 401s against its own data-provider.
    expect(SCRIPT).toContain('DATA_PROVIDER_API_KEY=${DATA_PROVIDER_KEY}');
    expect(SCRIPT).toContain('SCANI_CLOUD_API_KEY=${DATA_PROVIDER_KEY}');
  });

  test('BACKEND_URL is generated without a path', () => {
    // Better-Auth derives its route base path from BACKEND_URL, so a trailing
    // /api moves every auth route off the path the api serves. Nothing fails
    // at boot; sign-in just stops working (SC-453).
    const line = SCRIPT.split('\n').find((l) => l.startsWith('BACKEND_URL='));
    expect(line).toBeDefined();
    expect(line).toBe('BACKEND_URL=http://localhost:${SCANI_PORT}');
  });
});

describe('docker-compose.prod.yml service identity', () => {
  test('SERVICE_NAME carries the upstream spelling, not the private one', () => {
    // `REQUIRED_SERVICE_NAME` in packages/infra/realtime/src/websocket.ts is a
    // declared OSS/private scrubbed value (`service-name-scrub`, SC-205):
    // upstream says `api`, this tree says `scani-backend`. `assertInBackend`
    // THROWS on a mismatch from three unwrapped top-level call sites, so the
    // wrong spelling does not weaken a guard — it stops the api booting.
    //
    // This compose file is shared with the mirror and the images self-hosters
    // pull are built there, so it must carry the upstream spelling. SC-453
    // put the private spelling here, having verified it against a locally
    // built image, and every published api crash-looped until it was caught.
    expect(COMPOSE).toMatch(/^\s+SERVICE_NAME: api$/m);
    expect(COMPOSE).toMatch(/^\s+SERVICE_NAME: worker$/m);
    expect(COMPOSE).toMatch(/^\s+SERVICE_NAME: data-provider$/m);
    expect(COMPOSE).not.toMatch(/SERVICE_NAME:\s*scani-/);
  });
});

describe('self-host.sh refuses a re-run over a previous install (SC-479)', () => {
  // The script checks for leftover volumes by name, `${project}_${volume}`,
  // because that is exactly what compose would mount. So its list of volume
  // names has to be the compose file's list. Add a fourth named volume to the
  // compose file and the guard silently stops covering it: the install still
  // refuses on postgres-data, but a project left holding only the new volume
  // walks straight back into SC-479's `28P01` with no message about it.
  function composeVolumes(compose: string): string[] {
    const block = compose.split(/^volumes:$/m)[1];
    if (block === undefined) {
      throw new Error('docker-compose.prod.yml no longer has a top-level `volumes:` block');
    }
    const names: string[] = [];
    for (const line of block.split('\n').slice(1)) {
      if (line.trim() === '') continue;
      const match = line.match(/^ {2}([a-z0-9][a-z0-9._-]*):/);
      if (!match?.[1]) break;
      names.push(match[1]);
    }
    return names.sort();
  }

  function guardedVolumes(script: string): string[] {
    const line = script.split('\n').find((l) => l.startsWith('for volume in '));
    if (line === undefined) {
      throw new Error(
        'scripts/self-host.sh no longer loops over volume names to detect a previous install'
      );
    }
    return line.replace('for volume in ', '').replace('; do', '').trim().split(/\s+/).sort();
  }

  test('the compose file still declares named volumes', () => {
    expect(composeVolumes(COMPOSE).length).toBeGreaterThan(0);
  });

  test('the guard checks every volume the compose file creates', () => {
    expect(guardedVolumes(SCRIPT)).toEqual(composeVolumes(COMPOSE));
  });

  test('the guard runs before .env is generated', () => {
    // Order is the whole fix. Generating secrets first and checking after
    // leaves a .env on disk that does not match the volumes — which is the
    // unrecoverable state, reached by the script itself.
    expect(SCRIPT.indexOf('for volume in ')).toBeLessThan(SCRIPT.indexOf('cat > .env <<ENV'));
  });
});

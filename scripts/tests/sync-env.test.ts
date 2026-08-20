// SC-474 — a fresh worktree could not start the stack, so no UI change was
// ever looked at. `bun run dev:stack` runs sync-env.ts first, and sync-env.ts
// refused without a root `.env`. It now creates one.
//
// Two properties are worth a test rather than a review. The first is the
// refusal this replaces (a bootstrap that does not produce a bootable file is
// the same trap with a friendlier message). The second is the one that would
// be expensive to get wrong: a root `.env` holds whatever provider keys its
// owner pasted in, this script runs unattended on every `docker compose up`,
// and there is no undo.

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bootstrapRootEnv, parseEnv, renderRootEnv } from '../sync-env.ts';

const REPO_ROOT = path.resolve(import.meta.dir, '../..');
const REAL_EXAMPLE = path.join(REPO_ROOT, '.env.example');

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'scani-sync-env-'));
}

describe('renderRootEnv', () => {
  test('fills the blank keys the example ships and leaves the rest byte-identical', () => {
    const example = ['NODE_ENV=development', 'LOG_ID_PEPPER=', 'S3_BUCKET=scani-dev'].join('\n');
    const rendered = renderRootEnv(example, () => 'a'.repeat(64));
    const parsed = parseEnv(rendered);

    expect(parsed.LOG_ID_PEPPER).toBe('a'.repeat(64));
    expect(parsed.NODE_ENV).toBe('development');
    expect(parsed.S3_BUCKET).toBe('scani-dev');
  });

  test('leaves the non-blank dev placeholders alone', () => {
    // Not tidiness: docker-compose.yml hardcodes these same literals on the
    // backend and worker services. Generating a fresh value here would give a
    // host-side process a key the containers do not share, and credentials
    // written by one become undecryptable by the other.
    const example = [
      'ENCRYPTION_KEY=0123456789abcdef0123456789abcdef',
      'BETTER_AUTH_SECRET=dev_secret_change_me_this_is_not_production_safe',
    ].join('\n');

    expect(renderRootEnv(example, () => 'generated')).toBe(example);
  });

  test('the real .env.example produces a pepper that clears the 16-char floor', () => {
    // The one @scani/logging refuses production without. It is optional in
    // dev — measured, not assumed — but a generated one means local logs
    // pseudonymize IDs the way production does.
    const pepper = parseEnv(renderRootEnv(readFileSync(REAL_EXAMPLE, 'utf8'))).LOG_ID_PEPPER;
    expect(pepper).toBeDefined();
    expect(pepper.length).toBeGreaterThanOrEqual(16);
  });

  test('the real .env.example keeps every key it declares', () => {
    const example = readFileSync(REAL_EXAMPLE, 'utf8');
    const before = Object.keys(parseEnv(example)).sort();
    const after = Object.keys(parseEnv(renderRootEnv(example))).sort();
    expect(after).toEqual(before);
  });
});

describe('bootstrapRootEnv', () => {
  test('writes a mode-600 .env when there is none', () => {
    const dir = scratch();
    const envPath = path.join(dir, '.env');
    const examplePath = path.join(dir, '.env.example');
    writeFileSync(examplePath, 'NODE_ENV=development\nLOG_ID_PEPPER=\n');

    expect(bootstrapRootEnv(envPath, examplePath)).toBe(true);
    expect(existsSync(envPath)).toBe(true);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    expect(parseEnv(readFileSync(envPath, 'utf8')).LOG_ID_PEPPER.length).toBeGreaterThanOrEqual(16);
  });

  test('never rewrites an existing .env', () => {
    const dir = scratch();
    const envPath = path.join(dir, '.env');
    const examplePath = path.join(dir, '.env.example');
    writeFileSync(examplePath, 'NODE_ENV=development\nLOG_ID_PEPPER=\n');
    const mine = 'NODE_ENV=development\nOPENAI_API_KEY=sk-the-one-i-pasted\n';
    writeFileSync(envPath, mine);

    expect(bootstrapRootEnv(envPath, examplePath)).toBe(false);
    expect(readFileSync(envPath, 'utf8')).toBe(mine);
  });
});

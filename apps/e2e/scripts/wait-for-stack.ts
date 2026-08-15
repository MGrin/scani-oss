#!/usr/bin/env bun

// Same env vars, same defaults, as the fixtures that talk to these services
// (`fixtures/auth.ts`, `fixtures/mailpit.ts`, `playwright.config.ts`). The
// defaults are the compose stack's host ports; overriding them is what lets
// the suite run against host-side `bun dev` services on other ports, which is
// the loop an agent iterating on a spec actually uses.
const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';
const DATA_PROVIDER_URL = process.env.DATA_PROVIDER_URL ?? 'http://localhost:8082';
const FRONTEND_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173';
const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8026';

const TARGETS = [
  { name: 'api', url: `${API_BASE_URL}/health` },
  { name: 'data-provider', url: `${DATA_PROVIDER_URL}/health` },
  { name: 'frontend', url: `${FRONTEND_URL}/` },
  { name: 'mailpit', url: `${MAILPIT_URL}/api/v1/info` },
] as const;

const TIMEOUT_MS = 90_000;

async function probe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  const deadline = Date.now() + TIMEOUT_MS;
  const remaining = new Set(TARGETS.map((t) => t.name));

  while (remaining.size > 0 && Date.now() < deadline) {
    await Promise.all(
      TARGETS.filter((t) => remaining.has(t.name)).map(async (t) => {
        if (await probe(t.url)) {
          remaining.delete(t.name);
          console.log(`✓ ${t.name} ready`);
        }
      })
    );
    if (remaining.size > 0) await new Promise((r) => setTimeout(r, 1_000));
  }

  if (remaining.size > 0) {
    console.error(
      `Stack not ready after ${TIMEOUT_MS}ms. Still waiting on: ${[...remaining].join(', ')}`
    );
    process.exit(1);
  }

  console.log('All services ready.');
}

main();

#!/usr/bin/env bun

const TARGETS = [
  { name: 'api', url: 'http://localhost:3011/health' },
  { name: 'data-provider', url: 'http://localhost:8082/health' },
  { name: 'frontend', url: 'http://localhost:5173/' },
  { name: 'mailpit', url: 'http://localhost:8026/api/v1/info' },
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

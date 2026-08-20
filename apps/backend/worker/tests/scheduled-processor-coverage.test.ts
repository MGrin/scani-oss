import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as jobs from '@scani/jobs';
import { SCHEDULED_JOB_DESCRIPTORS } from '@scani/jobs';

/**
 * A schedule with no processor is worse than no schedule at all.
 *
 * `JobScheduler.upsertAll(SCHEDULED_JOB_DESCRIPTORS)` registers every
 * descriptor as a BullMQ repeatable, and `WorkerClient` throws
 * `No processor registered for job '<name>'` for any name absent from its
 * dispatch table. So adding a descriptor without its processor does not fail
 * the build, fail a test, or fail at boot — it fails once per cron tick, in
 * production, into the DLQ, until `dlq-depth-probe` pages someone.
 *
 * SC-283: shipped exactly that. `payment-due-reminder` was added to the
 * registry with `cron: '5 * * * *'` while its processor was still unwritten,
 * so main would have failed a job every hour from the moment it deployed.
 * Every gate passed, because nothing anywhere related the two lists.
 */

const WORKER_SRC = join(import.meta.dir, '..', 'src');
const PROCESSOR_DIR = join(WORKER_SRC, 'processors');

/** Constant name (`PRICING_SCHEDULE`) for each registered descriptor. */
function scheduleConstantNames(): Map<string, string> {
  const byDescriptor = new Map<string, string>();
  for (const descriptor of SCHEDULED_JOB_DESCRIPTORS) {
    const entry = Object.entries(jobs as Record<string, unknown>).find(
      ([, value]) => value === descriptor
    );
    if (!entry) throw new Error(`No @scani/jobs export for schedule '${descriptor.name}'`);
    byDescriptor.set(descriptor.name, entry[0]);
  }
  return byDescriptor;
}

/** `CONSTANT -> exported processor class` for every processor on disk. */
function processorsByConstant(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of readdirSync(PROCESSOR_DIR).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(join(PROCESSOR_DIR, file), 'utf8');
    const constant = source.match(/readonly descriptor\s*=\s*([A-Z_][A-Z0-9_]*)/)?.[1];
    const className = source.match(/export class\s+([A-Za-z0-9_]+)/)?.[1];
    if (constant && className) found.set(constant, className);
  }
  return found;
}

/** Class names inside `resolveProcessors()`, which is what actually registers. */
function registeredClasses(): Set<string> {
  const source = readFileSync(join(WORKER_SRC, 'index.ts'), 'utf8');
  const body = source.match(/function resolveProcessors\(\)\s*\{\s*return\s*\[([\s\S]*?)\]/)?.[1];
  if (!body) throw new Error('resolveProcessors() not found in worker index.ts');
  return new Set(
    Array.from(body.matchAll(/Container\.get\(([A-Za-z0-9_]+)\)/g), (m) => m[1]).filter(
      (name): name is string => name !== undefined
    )
  );
}

describe('every scheduled job has a processor that is actually registered', () => {
  test('each descriptor in SCHEDULED_JOB_DESCRIPTORS has a processor binding it', () => {
    const constants = scheduleConstantNames();
    const processors = processorsByConstant();

    const orphans = [...constants.entries()]
      .filter(([, constant]) => !processors.has(constant))
      .map(([jobName, constant]) => `${jobName} (${constant})`);

    expect(orphans).toEqual([]);
  });

  test('each of those processors is listed in resolveProcessors()', () => {
    const constants = scheduleConstantNames();
    const processors = processorsByConstant();
    const registered = registeredClasses();

    const unregistered = [...constants.entries()]
      .map(([jobName, constant]) => ({ jobName, className: processors.get(constant) }))
      .filter((p) => p.className && !registered.has(p.className))
      .map((p) => `${p.jobName} -> ${p.className}`);

    expect(unregistered).toEqual([]);
  });

  test('the registry is non-empty, so an empty parse cannot pass vacuously', () => {
    expect(SCHEDULED_JOB_DESCRIPTORS.length).toBeGreaterThan(10);
    expect(registeredClasses().size).toBeGreaterThan(10);
  });
});

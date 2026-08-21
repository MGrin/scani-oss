/**
 * SC-518 — demonstrate "no job lost, no job run twice" on BullMQ v6.
 *
 * Deliberately NOT part of `bun run test`. It needs a real Redis, and a gate
 * that fails on a machine without one is a gate people stop running — the same
 * reasoning that keeps `bun run visual` out of the gate. Run it by hand:
 *
 *   REDIS_URL=redis://localhost:6380 bun packages/infra/queue/scripts/verify-queue-invariant.ts
 *
 * Why a script and not an assertion in a test: the worker runs the portfolio
 * rollup, and a queue that drops or double-runs a job produces wrong numbers on
 * a real portfolio. A test that asserts exactly-once on a happy path would pass
 * on a queue that loses every job it was never given. These are experiments
 * that would CATCH a violation — each one has a control that fails on purpose.
 */
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

const URL_ = process.env.REDIS_URL ?? 'redis://localhost:6380';
const conn = () => new IORedis(URL_, { maxRetriesPerRequest: null });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Array<[string, boolean, string]> = [];
const record = (name: string, ok: boolean, detail: string) => {
  results.push([name, ok, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
};

async function fresh(name: string) {
  const q = new Queue(name, { connection: conn() });
  await q.obliterate({ force: true }).catch(() => undefined);
  return q;
}

// ---------------------------------------------------------------- 1. no double-run
// A stable custom jobId is what stops the same logical job running twice when
// two producers race (a user clicking twice, a cron replay landing on a deploy).
async function noDoubleRun() {
  const name = `inv_dedup_${process.pid}`;
  const q = await fresh(name);
  const seen: string[] = [];
  const w = new Worker(
    name,
    async (job) => {
      seen.push(String(job.id));
      await sleep(5);
    },
    { connection: conn(), concurrency: 8 }
  );
  await w.waitUntilReady();

  // 200 producers race to enqueue the SAME logical job.
  await Promise.all(
    Array.from({ length: 200 }, () => q.add('work', { n: 1 }, { jobId: 'stable-id' }))
  );
  await sleep(2500);
  record(
    'no job run twice — 200 races on one stable jobId',
    seen.length === 1,
    `processed ${seen.length} time(s), expected exactly 1`
  );

  // CONTROL. Without it, "1 run" is indistinguishable from a worker that
  // processes nothing at all — which is what a misconfigured queue looks like.
  const seen2: string[] = [];
  const name2 = `inv_dedup_ctl_${process.pid}`;
  const q2 = await fresh(name2);
  const w2 = new Worker(
    name2,
    async (job) => {
      seen2.push(String(job.id));
    },
    { connection: conn(), concurrency: 8 }
  );
  await w2.waitUntilReady();
  await Promise.all(
    Array.from({ length: 200 }, (_, i) => q2.add('work', { n: i }, { jobId: `id-${i}` }))
  );
  await sleep(3000);
  record(
    'CONTROL: 200 DISTINCT jobIds must all run (proves the counter works)',
    seen2.length === 200 && new Set(seen2).size === 200,
    `processed ${seen2.length}, unique ${new Set(seen2).size}, expected 200/200`
  );

  await w.close();
  await q.close();
  await w2.close();
  await q2.close();
}

// ---------------------------------------------------------------- 2. no job lost
// The one that matters. A worker dying mid-job must not swallow it: BullMQ
// stalls the job and another worker picks it up. This is the property that
// protects the rollup across a deploy, which replaces the worker machine.
async function noJobLost() {
  const name = `inv_lost_${process.pid}`;
  const q = await fresh(name);
  const N = 40;
  await Promise.all(
    Array.from({ length: N }, (_, i) => q.add('work', { i }, { jobId: `j-${i}`, attempts: 3 }))
  );

  const processed = new Set<string>();
  const starts: string[] = [];
  // Worker A takes jobs, then is hard-closed mid-flight (force) while holding
  // some — simulating the machine being replaced under it.
  const a = new Worker(
    name,
    async (job) => {
      starts.push(String(job.id));
      await sleep(120);
      processed.add(String(job.id));
    },
    { connection: conn(), concurrency: 4, stalledInterval: 1000, maxStalledCount: 5 }
  );
  await a.waitUntilReady();
  await sleep(500);
  await a.close(true); // force: in-flight jobs are abandoned, not completed

  const abandoned = starts.filter((id) => !processed.has(id));
  // Worker B picks up the pieces.
  const b = new Worker(
    name,
    async (job) => {
      starts.push(String(job.id));
      await sleep(20);
      processed.add(String(job.id));
    },
    { connection: conn(), concurrency: 4, stalledInterval: 1000, maxStalledCount: 5 }
  );
  await b.waitUntilReady();
  for (let i = 0; i < 40 && processed.size < N; i++) await sleep(500);

  record(
    'no job lost — worker force-killed mid-flight, all jobs still complete',
    processed.size === N,
    `${processed.size}/${N} completed; ${abandoned.length} were abandoned in-flight by the killed worker (${abandoned.slice(0, 4).join(',')}${abandoned.length > 4 ? '…' : ''})`
  );

  // The abandoned ones are the whole point: if none were abandoned, the kill
  // did nothing and this experiment proved only that a healthy queue works.
  record(
    'CONTROL: the kill actually abandoned in-flight jobs',
    abandoned.length > 0,
    `${abandoned.length} job(s) were mid-flight when the worker was force-closed`
  );

  await b.close();
  await q.close();
}

await noDoubleRun();
await noJobLost();

console.log('\n' + '='.repeat(72));
const failed = results.filter(([, ok]) => !ok);
console.log(
  failed.length === 0
    ? `INVARIANT HOLDS · ${results.length}/${results.length} checks passed on bullmq v6`
    : `INVARIANT VIOLATED · ${failed.length}/${results.length} failed: ${failed.map(([n]) => n).join('; ')}`
);
process.exit(failed.length === 0 ? 0 : 1);

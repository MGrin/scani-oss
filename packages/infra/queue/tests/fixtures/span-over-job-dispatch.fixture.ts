/**
 * Subprocess fixture for `worker-client-span.test.ts` (SC-822).
 *
 * IT RUNS IN ITS OWN PROCESS ON PURPOSE, for the same reason SC-751's fixture
 * does: `initSentry` sets a module-level flag and `Sentry.init` registers global
 * OpenTelemetry state, and `bun test` runs every file in ONE process — so
 * initializing a real client inside the suite would leave every later file with
 * a Sentry that actually transmits. The seam is the process boundary.
 *
 * It asserts on the ENVELOPES the SDK transmits, captured by a local sink
 * standing in for Sentry ingest, rather than on anything the code looks like it
 * does. A span that is never recorded and a job that never ran transmit the
 * same nothing, which is the state this ticket found in production: errors
 * arriving normally and not one span for a month, while the configuration read
 * as though tracing was on.
 *
 * Two arms against ONE initialized client:
 *   A  the processor invoked directly — what dispatch did before SC-822 -> 0
 *   B  the same processor through `WorkerClient`'s dispatch              -> > 0
 * A is not a formality. It is what distinguishes "dispatch is what starts the
 * span" from "the SDK instruments something in here on its own", and those two
 * produce the same non-zero in arm B.
 *
 * `initSentry` hardcodes `tracesSampleRate: 0.1` and this fixture deliberately
 * does not reach around it, so arm B is a 1-in-10 draw per dispatch. It runs the
 * arm ITERATIONS times instead: at 300 draws the chance of arm B reporting zero
 * against a working SDK is 0.9^300, about 2e-14.
 */
import { flushSentry, initSentry } from '@scani/logging/sentry';
import type { Job } from 'bullmq';
import { WorkerClient } from '../../src/consumer/worker-client';

const ITERATIONS = 300;
const JOB_NAME = 'sc822-probe';

type Item = { type: string; name?: string; op?: string; source?: string };
const received: Item[] = [];

const sink = Bun.serve({
  port: 0,
  async fetch(req) {
    // A Sentry envelope is newline-delimited JSON: one envelope header, then
    // (item header, item payload) pairs.
    const lines = (await req.text()).split('\n').filter(Boolean);
    for (let i = 1; i < lines.length; i += 2) {
      let header: { type?: string };
      try {
        header = JSON.parse(lines[i] as string);
      } catch {
        continue;
      }
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(lines[i + 1] ?? '{}');
      } catch {
        // Item payloads are not all JSON (attachments, profiles). Not ours.
      }
      received.push({
        type: String(header.type),
        name: payload.transaction as string | undefined,
        op: (payload.contexts as { trace?: { op?: string } } | undefined)?.trace?.op,
        source: (payload.transaction_info as { source?: string } | undefined)?.source,
      });
    }
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  },
});

process.env.SENTRY_DSN = `http://sc822publickey@127.0.0.1:${sink.port}/1`;
initSentry({ component: 'worker' });

const transactionsSoFar = () => received.filter((item) => item.type === 'transaction');

let processorCalls = 0;
const processor = {
  descriptor: { name: JOB_NAME },
  process: async () => {
    processorCalls++;
    await Bun.sleep(0);
    return { ok: true };
  },
};

const client = new WorkerClient();
// `register` is the real registration path; only `start()` needs a database,
// and dispatch does not go through it.
client.register(processor as unknown as Parameters<WorkerClient['register']>[0]);

const job = { id: 'sc822-1', name: JOB_NAME, data: {} } as unknown as Job;

// ---- Arm A: the processor called directly, with nobody asking for a span ----
for (let i = 0; i < ITERATIONS; i++) {
  await processor.process();
}
await flushSentry(5000);
await Bun.sleep(150);
const armA = transactionsSoFar().length;

// ---- Arm B: the same work, through the dispatch this repo instrumented ----
// `runJob` is private: it is dispatch, not API, and BullMQ hands it to a
// `Worker` that would need a database. Reaching it here is what makes this a
// test of the shipped path rather than of a copy of it.
const runJob = (client as unknown as { runJob: (job: Job) => Promise<unknown> }).runJob.bind(
  client
);
for (let i = 0; i < ITERATIONS; i++) {
  await runJob(job);
}
await flushSentry(5000);
await Bun.sleep(150);
const armBItems = transactionsSoFar().slice(armA);

console.log(
  `SC822_RESULT ${JSON.stringify({
    iterations: ITERATIONS,
    processorCalls,
    armA_directCallTransactions: armA,
    armB_dispatchTransactions: armBItems.length,
    armB_names: [...new Set(armBItems.map((item) => item.name))],
    armB_ops: [...new Set(armBItems.map((item) => item.op))],
    armB_sources: [...new Set(armBItems.map((item) => item.source))],
  })}`
);

sink.stop();
process.exit(0);

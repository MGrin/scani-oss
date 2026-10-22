/**
 * Subprocess fixture for `sentry-span-over-bun-serve.test.ts` (SC-751).
 *
 * IT RUNS IN ITS OWN PROCESS ON PURPOSE. `initSentry` sets a module-level flag
 * and `Sentry.init` registers global OpenTelemetry state; `bun test` runs every
 * file in ONE process, so initializing a real client inside the suite would
 * leave every later file with a Sentry that actually transmits. The seam is the
 * process boundary.
 *
 * It asserts on the ENVELOPES the SDK transmits, captured by a local sink
 * standing in for Sentry ingest, rather than on anything the code looks like it
 * does — a span that is never recorded and a request that never happened
 * transmit the same nothing.
 *
 * Two arms against ONE initialized client, so neither can pass for the wrong
 * reason:
 *   A  requests served by `Bun.serve`, no span asked for  -> expect 0
 *   B  the same count of `withSpan` calls                 -> expect > 0
 * B is A's control: it is what distinguishes "Bun.serve is not instrumented"
 * from "the sink, the DSN or the flush never worked", which produce the same 0.
 *
 * `initSentry` samples most spans at 10% and this fixture deliberately does
 * not reach around it, so arm B is a 1-in-10 draw per call. It runs the
 * arm ITERATIONS times instead: at 300 draws the chance of arm B reporting zero
 * against a working SDK is 0.9^300, about 2e-14. Arm A needs no such argument —
 * nothing samples a span that was never started.
 *
 * Arm C (SC-1745): getReturns is sampled whole, and an attribute set after an
 * `await` inside the span reaches the transmitted transaction. Expect exactly
 * one transaction per call, each carrying the attribute.
 */
import { flushSentry, initSentry, setSpanAttributes, withSpan } from '../../src/sentry';

const ITERATIONS = 300;
const FULL_CALLS = 20;

type Item = { type: string; name?: string; op?: string; data?: Record<string, unknown> };
const received: Item[] = [];

const sink = Bun.serve({
  port: 0,
  async fetch(req) {
    // A Sentry envelope is newline-delimited JSON: one envelope header, then
    // (item header, item payload) pairs.
    const body = new Uint8Array(await req.arrayBuffer());
    const decoded = req.headers.get('content-encoding') === 'gzip' ? Bun.gunzipSync(body) : body;
    const lines = new TextDecoder().decode(decoded).split('\n').filter(Boolean);
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
        data: (payload.contexts as { trace?: { data?: Record<string, unknown> } } | undefined)
          ?.trace?.data,
      });
    }
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  },
});

process.env.SENTRY_DSN = `http://sc751publickey@127.0.0.1:${sink.port}/1`;
initSentry({ component: 'backend' });

const transactionsSoFar = () => received.filter((item) => item.type === 'transaction');

// ---- Arm A: an ordinary Bun.serve request, with nobody asking for a span ----
const subject = Bun.serve({
  port: 0,
  fetch: () => new Response('ok'),
});
for (let i = 0; i < ITERATIONS; i++) {
  await fetch(`http://127.0.0.1:${subject.port}/trpc/probe`);
}
subject.stop();
await flushSentry(5000);
await Bun.sleep(150);
const armA = transactionsSoFar().length;

// ---- Arm B: the same work, wrapped in the span this repo asks for ----
for (let i = 0; i < ITERATIONS; i++) {
  await withSpan({ name: 'trpc/sc751.probe', op: 'rpc.server' }, async () => {
    await Bun.sleep(0);
  });
}
await flushSentry(5000);
await Bun.sleep(150);
const armBItems = transactionsSoFar().slice(armA);

// ---- Arm C: the fully traced procedure, tagged after an await ----
const beforeC = transactionsSoFar().length;
for (let i = 0; i < FULL_CALLS; i++) {
  await withSpan({ name: 'trpc/portfolio.getReturns', op: 'rpc.server' }, async () => {
    await Bun.sleep(1);
    setSpanAttributes({ 'returns.cache': 'miss', 'returns.version_ms': i });
  });
}
await flushSentry(5000);
await Bun.sleep(150);
const armCItems = transactionsSoFar()
  .slice(beforeC)
  .filter((item) => item.name === 'trpc/portfolio.getReturns');

console.log(
  `SC751_RESULT ${JSON.stringify({
    iterations: ITERATIONS,
    armA_bunServeTransactions: armA,
    armB_withSpanTransactions: armBItems.length,
    armB_names: [...new Set(armBItems.map((item) => item.name))],
    armB_ops: [...new Set(armBItems.map((item) => item.op))],
    armC_calls: FULL_CALLS,
    armC_transactions: armCItems.length,
    armC_tagged: armCItems.filter((item) => item.data?.['returns.cache'] === 'miss').length,
  })}`
);

sink.stop();
process.exit(0);

import { describe, expect, test } from 'bun:test';

/**
 * SC-822. A deployed build of this app reported errors normally and not one
 * performance span for a month. The SDK was initialized and error capture
 * worked; `browserTracingIntegration` was deliberately left out,
 * because it and `replayIntegration` were understood to compile predicates via
 * `new Function(...)`, which this app's `script-src 'self'` CSP blocks — and
 * the SDK surfaced the block as an unhandled EvalError on every page load.
 *
 * WHAT THIS TEST IS, AND WHAT IT DELIBERATELY IS NOT. It is a source-text
 * tripwire over a DECISION, not evidence that anything transmits — reading the
 * config is exactly what said tracing was fine on the backend for months while
 * the project recorded no route at all. The transmission claim was taken by
 * hand against a real browser and a local ingest sink, and `main.tsx` carries
 * the measurement. Nothing here re-takes it, and nothing here should be read as
 * though it had.
 *
 * What it CAN catch is the pair of regressions that leave no other trace:
 * tracing being dropped again in a config edit, and — the one worth having —
 * somebody meeting a future eval-shaped failure and reaching for
 * `'unsafe-eval'` in the CSP rather than asking whether the integration
 * belongs. That second one weakens a real security control to fix a monitoring
 * inconvenience, and it would otherwise read as a one-token diff.
 */

const MAIN = await Bun.file(new URL('../../src/main.tsx', import.meta.url)).text();

/**
 * The `integrations: [...]` argument, not the whole file. Every claim below is
 * about what is PASSED, and the prose around it names the same identifiers —
 * so a whole-file match cannot tell a call from the comment explaining why the
 * call is not there.
 */
const INTEGRATIONS = (() => {
  const start = MAIN.indexOf('integrations: [');
  if (start === -1) throw new Error('main.tsx passes no `integrations` array to Sentry.init');
  const end = MAIN.indexOf(']', start);
  return MAIN.slice(start, end + 1);
})();
const HEADERS = await Bun.file(new URL('../../public/_headers', import.meta.url)).text();
const NGINX = await Bun.file(
  new URL('../../nginx-security-headers.inc.template', import.meta.url)
).text();

describe('frontend Sentry performance tracing', () => {
  test('browser tracing is enabled, with a sample rate', () => {
    expect(INTEGRATIONS).toContain('browserTracingIntegration()');
    expect(MAIN).toMatch(/tracesSampleRate:\s*[\d.]+/);
  });

  test('session replay stays off — nothing measured it under this CSP', () => {
    expect(INTEGRATIONS).not.toContain('replayIntegration');
  });

  test.each([
    ['public/_headers', HEADERS],
    ['nginx-security-headers.inc.template', NGINX],
  ])("%s keeps script-src free of 'unsafe-eval'", (_name, source) => {
    // The control: this only means anything if the file declares a CSP at all,
    // and an absent one would otherwise pass for the wrong reason.
    expect(source).toContain('script-src');
    expect(source).not.toContain("'unsafe-eval'");
  });
});

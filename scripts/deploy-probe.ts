#!/usr/bin/env bun

// Prove what a live deploy is actually SERVING, or refuse to say (SC-821).
//
// Usage:
//   bun scripts/deploy-probe.ts --url https://app.scani.xyz --commit "$(git rev-parse HEAD)"
//   bun scripts/deploy-probe.ts --url https://app.scani.xyz \
//     --signal 'typeCode==="fiat"' --alive 'typeCode'
//   bun scripts/deploy-probe.ts --url https://app.scani.xyz --against https://<prev>.pages.dev
//   bun scripts/deploy-probe.ts --url https://app.scani.xyz --commit HEAD --simulate-fallback
//
// Exit codes:
//   0  every arm that could run agrees the artefact carries what you named
//   1  an arm RAN and disagrees — a measured absence
//   9  UNVERIFIED — nothing was read, so this says nothing about the deploy
//
// ## Why not `curl ... | grep -c`
//
// Because `0` has two meanings and grep reports one number. A single-page host
// answers HTTP 200 for any unknown asset path and hands back `index.html`, so a
// stale chunk name reads as present, every count over it reads 0, and a probe
// with only a must-be-ABSENT arm reports that as *the change did not ship*.
// Measured against the live app 2026-09-03, running SC-821's own falsifier:
//
//     index-BveKii2S.js  -> 200  text/html  5013 bytes  "<!doctype html>"
//     index-ZZZZfake0.js -> 200  text/html  5013 bytes  cmp IDENTICAL
//
// Both arms zero, over a 200. That is the whole defect, and it is not specific
// to Cloudflare Pages: `docs/SELF_HOST.md` puts the SPA behind nginx, where
// `try_files $uri /index.html` produces it identically.
//
// ## Never hardcode a chunk hash
//
// SC-821's falsifier named `index-BveKii2S.js`, which was already several
// deploys stale four days later. This resolves the entry chunk from
// `index.html` on every run, so the input that rots is not an input.
//
// ## The arms, and which one to reach for
//
//   shape      always, first, and it can only REFUSE. Status, content-type,
//              opening bytes, and a byte comparison against a deliberately
//              invented sibling path. Run PER ARTEFACT — a control's pass does
//              not travel to a sibling.
//   identity   `--commit`. The strongest arm and it needs no per-change design:
//              the served bundle names the commit it was built from, so
//              ancestry answers "is my change in there" outright. Available on
//              hosts whose deploy passes a Sentry DSN; UNAVAILABLE, not absent,
//              elsewhere.
//   signal     `--signal` + `--alive`. The fallback where identity is
//              unavailable, and the only arm that answers "did THIS code ship"
//              rather than "which commit built this". Search the ADJACENCY a
//              change creates, not the tokens its diff adds — minifiers
//              preserve property names and string literals, so `typeCode==="fiat"`
//              is new even though neither `typeCode` nor `fiat` is.
//   difference `--against`. Reports which asset hashes MOVED and which HELD
//              between two deployments, so you can name an artefact your change
//              could not have touched instead of trusting that hashes mean
//              something.
//
// ## What it reads, which is narrower than "the app"
//
// The entry chunk and whatever `--asset` adds. A change living in a lazily
// loaded route chunk is genuinely absent from the entry chunk, so a 0 there is
// a fact about the artefacts named on the verdict line and not about the app.
// Every verdict prints which URLs it read, for that reason.

import { EXIT_OK, EXIT_REFUSED, EXIT_UNKNOWN, runGit } from './lib/check-verdict.ts';
import {
  type ArmVerdict,
  classifyIndex,
  classifyShape,
  countLiteral,
  type Expectation,
  extractAssets,
  extractRelease,
  type Fetched,
  manifestDiff,
  type ShapeVerdict,
  signalVerdict,
  worstOf,
} from './lib/deploy-probe.ts';

/** A path no build has ever emitted, so whatever comes back is the fallback. */
const INVENTED = '/assets/index-ZZZZprobe0.js';

async function get(url: string): Promise<Fetched> {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    return {
      url,
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      body: await res.text(),
    };
  } catch (e) {
    // A network failure must not become an empty body: `''` counts 0 for every
    // arm, which is the dead-instrument reading wearing a genuine absence.
    return { url, status: 0, contentType: '', body: ` unreachable: ${(e as Error).message}` };
  }
}

/**
 * Ancestry, with "not an ancestor" and "git could not answer" kept apart.
 *
 * `runGit` collapses every non-zero exit into `failed`, and here exit 1 is the
 * ANSWER — the commit is genuinely not contained. Reading it as a failure would
 * turn a real red into an unverified, which is the one direction that hides a
 * deploy that did not ship.
 */
function isAncestor(a: string, b: string, cwd: string): 'yes' | 'no' | { why: string } {
  if (runGit(['cat-file', '-e', `${a}^{commit}`], cwd).kind === 'failed') {
    return {
      why: `${a} is not a commit in this checkout — fetch before reading this as "not deployed"`,
    };
  }
  if (runGit(['cat-file', '-e', `${b}^{commit}`], cwd).kind === 'failed') {
    return {
      why: `the served commit ${b.slice(0, 12)} is unknown to this checkout — run \`git fetch\` and re-run`,
    };
  }
  const proc = Bun.spawnSync(['git', 'merge-base', '--is-ancestor', a, b], { cwd });
  if (proc.exitCode === 0) return 'yes';
  if (proc.exitCode === 1) return 'no';
  const said = new TextDecoder().decode(proc.stderr).trim().split('\n')[0] ?? '';
  return { why: `git merge-base exited ${proc.exitCode}${said === '' ? '' : `: ${said}`}` };
}

function flag(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(name);
  return at === -1 ? null : (argv[at + 1] ?? '');
}

function mark(state: string): string {
  if (state === 'pass') return 'ok  ';
  if (state === 'fail') return 'FAIL';
  if (state === 'unavailable') return 'n/a ';
  return '??  ';
}

async function main(argv: readonly string[]): Promise<number> {
  const url = flag(argv, '--url');
  if (url === null || url === '') {
    console.error(
      'usage: bun scripts/deploy-probe.ts --url <origin> [--commit <sha>] [--signal <literal> --alive <substring>] [--expect present|absent] [--asset <path>] [--against <origin>] [--simulate-fallback]'
    );
    return EXIT_UNKNOWN;
  }
  const origin = url.replace(/\/+$/, '');
  const commit = flag(argv, '--commit');
  const signal = flag(argv, '--signal');
  const alive = flag(argv, '--alive');
  const against = flag(argv, '--against');
  const expect = (flag(argv, '--expect') ?? 'present') as Expectation;
  const extra = argv
    .flatMap((a, i) => (a === '--asset' ? [argv[i + 1] ?? ''] : []))
    .filter((a) => a !== '');

  // This probe's own falsifier. It makes every artefact read return what the
  // host's fallback returns, so the UNVERIFIED arm is observable in one step
  // without waiting for a chunk hash to go stale. Every line it prints says
  // SIMULATED, so a run that used it cannot be quoted as evidence about a real
  // deploy.
  const simulated = argv.includes('--simulate-fallback');
  const tail = simulated ? '  (SIMULATED fallback — nothing was read from the network)' : '';

  if (expect !== 'present' && expect !== 'absent') {
    console.error(`--expect takes 'present' or 'absent'; got '${expect}'`);
    return EXIT_UNKNOWN;
  }
  // Refused rather than defaulted. A signal reading with no alive arm beside it
  // cannot tell a clean read from a dead one, which is the defect this whole
  // script exists for — so the tool must not be able to produce one.
  if (signal !== null && (alive === null || alive === '')) {
    console.error(
      `--signal needs --alive: a substring of the signal, counted on the SAME fetch. Without it a 0 cannot be told from a read that never happened.`
    );
    return EXIT_UNKNOWN;
  }

  const control = await get(`${origin}${INVENTED}`);
  const fallbackBody = control.status === 200 ? control.body : null;
  const index = await get(origin);

  console.log(`deploy-probe — ${origin}${tail}`);
  console.log(
    `  control ${INVENTED} — HTTP ${control.status}, ${control.contentType || 'no content-type'}, ${control.body.length} bytes` +
      (fallbackBody === null ? ' (no fallback body, so the byte-identity tell is off)' : '')
  );

  // `classifyIndex`, NOT `classifyShape`: on an index document `text/html` is
  // correct rather than a tell, so the asset arm condemns every healthy one.
  const indexRead = classifyIndex(index);
  if (indexRead.kind !== 'index') {
    console.log(`  ${mark('fail')} ${origin}/ — ${indexRead.why}`);
    console.log(
      `deploy-probe: UNVERIFIED · exit ${EXIT_UNKNOWN} · the index document could not be read, so no asset could be resolved${tail}`
    );
    return EXIT_UNKNOWN;
  }

  const wanted = [...new Set([...indexRead.assets, ...extra])];
  const js = wanted.filter((a) => a.endsWith('.js'));
  if (js.length === 0) {
    console.log(
      `deploy-probe: UNVERIFIED · exit ${EXIT_UNKNOWN} · ${origin}/ references no /assets/*.js, so there is nothing to count over${tail}`
    );
    return EXIT_UNKNOWN;
  }

  // Fetched per artefact, and shape-classified per artefact. One control fetch
  // supplies the comparison body for all of them; the COMPARISON is still made
  // against each one, which is the half that must not be shared.
  const chunks: { path: string; got: Fetched; shape: ShapeVerdict }[] = [];
  for (const path of js) {
    const got = simulated
      ? {
          url: `${origin}${path}`,
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: fallbackBody ?? '<!doctype html>',
        }
      : await get(`${origin}${path}`);
    chunks.push({ path, got, shape: classifyShape(got, fallbackBody) });
  }

  console.log(`  read ${chunks.length} JS artefact(s) referenced by ${origin}/:`);
  for (const c of chunks) {
    console.log(
      `    ${mark(c.shape.kind === 'real' ? 'pass' : 'fail')} ${c.path} — ` +
        (c.shape.kind === 'real'
          ? `HTTP ${c.got.status}, ${c.got.contentType}, ${c.shape.bytes} bytes`
          : c.shape.why)
    );
  }

  const readable = chunks.flatMap((c) => (c.shape.kind === 'real' ? [c] : []));
  if (readable.length === 0) {
    console.log(
      `deploy-probe: UNVERIFIED · exit ${EXIT_UNKNOWN} · every artefact came back as the host's fallback, so every count over them would read 0 for a reason that has nothing to do with your change${tail}`
    );
    return EXIT_UNKNOWN;
  }
  const corpus = readable.map((c) => c.got.body).join('\n');

  const arms: ArmVerdict[] = [];

  if (commit !== null && commit !== '') {
    const served = readable.map((c) => extractRelease(c.got.body)).find((r) => r !== null) ?? null;
    if (served === null) {
      arms.push({
        arm: 'identity',
        state: 'unavailable',
        // The distinction this file exists to keep: no marker is a fact about
        // the HOST, never about the commit.
        detail: `no release marker in ${readable.length} readable artefact(s) — this host's deploy passes no Sentry DSN, so it cannot say which commit it serves. NOT a claim that your commit is absent`,
      });
    } else {
      const head = runGit(['rev-parse', commit], process.cwd());
      const want = head.kind === 'ran' ? head.stdout.trim() : commit;
      const verdict = isAncestor(want, served, process.cwd());
      if (verdict === 'yes') {
        arms.push({
          arm: 'identity',
          state: 'pass',
          detail: `served commit ${served.slice(0, 12)} contains ${want.slice(0, 12)}`,
        });
      } else if (verdict === 'no') {
        arms.push({
          arm: 'identity',
          state: 'fail',
          detail: `served commit ${served.slice(0, 12)} does NOT contain ${want.slice(0, 12)} — the deploy predates your change`,
        });
      } else {
        arms.push({ arm: 'identity', state: 'unverified', detail: verdict.why });
      }
    }
  }

  if (signal !== null && alive !== null) {
    arms.push(
      signalVerdict({
        signal,
        signalCount: countLiteral(corpus, signal),
        alive,
        aliveCount: countLiteral(corpus, alive),
        expect,
      })
    );
  }

  if (against !== null && against !== '') {
    const other = await get(against.replace(/\/+$/, ''));
    const otherRead = classifyIndex(other);
    if (otherRead.kind !== 'index') {
      arms.push({ arm: `difference vs ${against}`, state: 'unverified', detail: otherRead.why });
    } else {
      const { moved, held } = manifestDiff(otherRead.assets, indexRead.assets);
      arms.push(
        moved.length === 0
          ? {
              arm: `difference vs ${against}`,
              state: 'unverified',
              detail:
                'no asset hash moved — both URLs served the same build, so the comparison is void',
            }
          : {
              arm: `difference vs ${against}`,
              state: 'pass',
              // HELD is the load-bearing half: it is what rules out "every hash
              // moves every build" from inside the same fetch pair. Which held
              // artefact your change could not have touched is yours to name.
              detail: `${moved.length} moved [${moved.join(' ')}], ${held.length} HELD [${held.join(' ') || 'none — nothing here rules out every hash moving every build'}]`,
            }
      );
    }
  }

  if (arms.length === 0) {
    console.log(
      `deploy-probe: UNVERIFIED · exit ${EXIT_UNKNOWN} · read ${readable.length} artefact(s) and was given nothing to check them against — pass --commit, or --signal with --alive${tail}`
    );
    return EXIT_UNKNOWN;
  }

  for (const a of arms) console.log(`  ${mark(a.state)} ${a.arm}: ${a.detail}`);

  // The denominator, on every verdict, naming the artefacts a conclusion is
  // scoped to. A must-be-ABSENT reading is a fact about THESE bytes; a change
  // in a lazily loaded chunk is legitimately absent from all of them.
  const scope = `over ${readable.map((c) => c.path).join(' ')}`;
  switch (worstOf(arms)) {
    case 'unverified':
      console.log(
        `deploy-probe: UNVERIFIED · exit ${EXIT_UNKNOWN} · ${scope} · an arm could not be read, so this is not evidence either way${tail}`
      );
      return EXIT_UNKNOWN;
    case 'fail':
      console.log(`deploy-probe: NOT SERVED · exit ${EXIT_REFUSED} · ${scope}${tail}`);
      return EXIT_REFUSED;
    case 'unavailable':
      console.log(
        `deploy-probe: UNVERIFIED · exit ${EXIT_UNKNOWN} · ${scope} · every arm was unavailable on this host — nothing was compared${tail}`
      );
      return EXIT_UNKNOWN;
    default:
      console.log(`deploy-probe: SERVED · exit ${EXIT_OK} · ${scope}${tail}`);
      return EXIT_OK;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}

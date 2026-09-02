/**
 * Deciding what a fetched deploy artefact PROVES — the half with no network in
 * it, so every arm below can be pinned by a test rather than by a deploy.
 *
 * ## The defect this exists for (SC-821)
 *
 * A deploy probe asks *"is a string that is new in this release present in the
 * served artefact?"* For a copy or locale change that works. For a BEHAVIOUR
 * change the diff adds no new literal, the probe finds nothing, and it does not
 * say so — it degrades to *"something deployed"* while still reading green on
 * somebody else's commit. **The silence is the defect.** A probe reporting *no
 * discriminator available* would be fine; this one reports success.
 *
 * Two readings are indistinguishable to a bare `grep -c`, and they mean
 * opposite things:
 *
 *   0 because the code is genuinely absent   -> the change did not ship
 *   0 because nothing was read at all        -> the probe is dead, and says nothing
 *
 * Separating them is the entire job here, and it takes three arms rather than
 * one. {@link classifyShape} refuses to count over an artefact that is not the
 * artefact. {@link signalVerdict} refuses a signal reading that has no alive
 * arm beside it. {@link extractRelease} answers the question directly where the
 * host offers it, and reports itself UNAVAILABLE rather than ABSENT where it
 * does not — because *"this host carries no commit marker"* and *"your commit
 * is not deployed"* are also the same value to a careless reader.
 */

/** One artefact as it came off the wire. `body` is the decoded text. */
export interface Fetched {
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

/**
 * Whether an artefact is the thing that was asked for, or the SPA fallback
 * wearing its name.
 *
 * `real` carries the byte length so a verdict can print a DENOMINATOR: a run
 * that counted over 300 bytes and one that counted over 1 MB must not look
 * alike.
 */
export type ShapeVerdict =
  | { readonly kind: 'real'; readonly bytes: number }
  | { readonly kind: 'fallback'; readonly why: string }
  | { readonly kind: 'unreachable'; readonly why: string };

const HTML_OPENERS = ['<!doctype html', '<!DOCTYPE html', '<html'];

/**
 * SHAPE ARM — FIRST AND ALWAYS.
 *
 * A single-page host answers **HTTP 200** for any unknown path under its asset
 * directory and hands back `index.html`. Cloudflare Pages does it on
 * `app.scani.xyz`; an nginx `try_files $uri /index.html` in front of the
 * self-host image does exactly the same. So a fetch of a stale chunk name comes
 * back 200, and every count taken over it reads 0 — the dead-instrument
 * reading, wearing the same value as a genuine absence.
 *
 * Three tells, checked in order of how durable they are:
 *
 *   1. `content-type` is `text/html` where JavaScript was asked for.
 *   2. the body opens with an HTML document.
 *   3. the body is IDENTICAL to what a deliberately invented sibling path
 *      returned — the control that needs to know nothing about the build.
 *
 * **Not the byte count.** SC-821's own ticket recorded the fallback at 3992
 * bytes; it was 5013 when this was written, four days later, because
 * `index.html` is a living file. A check keyed on that number stops firing and
 * says nothing when it does.
 *
 * `control` is the body of that invented path, or `null` when it was not
 * fetched. Passing it is what makes tell 3 available.
 *
 * **Call this per ARTEFACT, never once per batch.** The two files behind that finding were fetched by the same command shape, from the same host,
 * in the same minute, and named `index-<hash>.js`; one was real JavaScript and
 * the other was fabricated. The control was run — on the healthy one — and its
 * verdict was carried to the sick one. A control's pass does not travel to a
 * sibling.
 */
export function classifyShape(got: Fetched, control: string | null): ShapeVerdict {
  if (got.status !== 200) {
    return { kind: 'unreachable', why: `HTTP ${got.status}` };
  }
  if (control !== null && got.body === control) {
    return {
      kind: 'fallback',
      why: 'byte-identical to a deliberately invented sibling path, so this is the SPA fallback and not this artefact',
    };
  }
  if (/\btext\/html\b/.test(got.contentType)) {
    return { kind: 'fallback', why: `content-type is '${got.contentType}'` };
  }
  const head = got.body.slice(0, 64);
  const opener = HTML_OPENERS.find((o) => head.startsWith(o));
  if (opener !== undefined) {
    return { kind: 'fallback', why: `body opens '${opener}', so it is an HTML document` };
  }
  return { kind: 'real', bytes: got.body.length };
}

/** Every `/assets/...` reference an HTML document makes, deduplicated and sorted. */
export function extractAssets(html: string): string[] {
  return [...new Set(html.match(/\/assets\/[A-Za-z0-9._-]+\.(?:js|css)/g) ?? [])].sort();
}

/**
 * Whether an INDEX document was really read — a different question from
 * {@link classifyShape}, which must not be pointed at one.
 *
 * The shape arm reads `text/html` as the tell that an ASSET request was
 * answered by the fallback. On the index that content-type is simply correct,
 * so the same arm condemns every healthy index document. Measured 2026-09-03:
 * pointing `classifyShape` at an index made the `--against` comparison report
 * UNVERIFIED against a perfectly good deployment, on all three inputs tried —
 * which is this ticket's own defect, in the tool written to close it, in the one
 * arm that had not been exercised live.
 *
 * The tell that survives is REFERENCES: a document that names no `/assets/*` is
 * not an index whatever its content-type says, and one that names some was read.
 */
export type IndexVerdict =
  | { readonly kind: 'index'; readonly assets: string[] }
  | { readonly kind: 'not-an-index'; readonly why: string };

export function classifyIndex(got: Fetched): IndexVerdict {
  if (got.status !== 200) return { kind: 'not-an-index', why: `HTTP ${got.status}` };
  const assets = extractAssets(got.body);
  return assets.length === 0
    ? {
        kind: 'not-an-index',
        why: `${got.body.length} bytes referencing no /assets/* at all, so there is nothing to resolve`,
      }
    : { kind: 'index', assets };
}

/**
 * The commit a served bundle was built from, when the host puts one there.
 *
 * On `app.scani.xyz` it is `VITE_SENTRY_RELEASE`, which the deploy sets to the
 * commit being shipped. It is referenced only inside `if (SENTRY_DSN)` in
 * `main.tsx`, so Vite eliminates it when no DSN is passed — which makes it a
 * genuine marker rather than a decorative one, present IFF the build consumed
 * its inputs. Any deploy that sets both variables gets this arm for free; one
 * that sets neither gets `null`, which is the case below.
 *
 * **It is not universal, and treating its absence as a verdict is the bug one
 * level up.** Measured 2026-09-03 in one pass: `app.scani.xyz` carries it,
 * `scani.xyz` and `cloud.scani.xyz` serve real JavaScript with no marker at all
 * (their deploys pass no DSN), and `docs.scani.xyz` references no
 * `/assets/*.js`. So `null` here means *this host does not answer that
 * question* and must never be rendered as *your commit is not deployed*.
 */
export function extractRelease(js: string): string | null {
  return /\brelease\s*:\s*["']([0-9a-f]{40})["']/.exec(js)?.[1] ?? null;
}

/**
 * Non-overlapping occurrences of a literal.
 *
 * A literal rather than a pattern on purpose: the searchable unit for a
 * behaviour change is a post-minification CODE SHAPE — `typeCode==="fiat"` —
 * which is full of characters a regex would read as syntax.
 */
export function countLiteral(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let n = 0;
  for (
    let i = haystack.indexOf(needle);
    i !== -1;
    i = haystack.indexOf(needle, i + needle.length)
  ) {
    n += 1;
  }
  return n;
}

export type Expectation = 'present' | 'absent';

export interface SignalReading {
  readonly signal: string;
  readonly signalCount: number;
  readonly alive: string;
  readonly aliveCount: number;
  readonly expect: Expectation;
}

export type ArmState = 'pass' | 'fail' | 'unverified' | 'unavailable';

export interface ArmVerdict {
  readonly arm: string;
  readonly state: ArmState;
  readonly detail: string;
}

/**
 * SIGNAL + ALIVE — why the alive arm is mandatory rather than advisory.
 *
 * A must-be-ABSENT arm cannot distinguish a clean read from a dead instrument:
 * both read 0. A SUBSTRING of the same pattern, counted on the SAME fetch, can
 * only be non-zero if the read happened. SC-821's own readings:
 *
 *     deploy 2   typeCode==="fiat" = 0     typeCode = 2   <- alive, so the 0 is measured
 *     deploy 3   typeCode==="fiat" = 1     typeCode = 3
 *     live       typeCode==="fiat" = 1     typeCode = 3
 *
 * The `2` on deploy 2 is what turns that `0` into an ABSENCE rather than a
 * possibly-dead read.
 *
 * `alive` must be a substring of `signal`. An unrelated token would go on
 * reading non-zero after the signal moved, which is an alive arm that cannot
 * fail — the same defect this function exists to prevent, one level in.
 */
export function signalVerdict(r: SignalReading): ArmVerdict {
  const arm = `signal '${r.signal}' (expect ${r.expect})`;
  if (!r.signal.includes(r.alive)) {
    return {
      arm,
      state: 'unverified',
      detail: `alive literal '${r.alive}' is not a substring of the signal, so it can stay non-zero after the signal moves and could never report a dead read`,
    };
  }
  if (r.aliveCount === 0) {
    return {
      arm,
      state: 'unverified',
      detail: `alive '${r.alive}' counted 0 — the read is VOID, and the signal's ${r.signalCount} says nothing either way`,
    };
  }
  const counts = `signal=${r.signalCount} alive=${r.aliveCount}`;
  if (r.expect === 'present') {
    return r.signalCount > 0
      ? { arm, state: 'pass', detail: `${counts} — in the served bytes` }
      : {
          arm,
          state: 'fail',
          detail: `${counts} — a MEASURED absence: the read happened and the shape is not there`,
        };
  }
  return r.signalCount === 0
    ? { arm, state: 'pass', detail: `${counts} — a MEASURED absence` }
    : { arm, state: 'fail', detail: `${counts} — expected absent and it is present` };
}

/**
 * IDENTITY — and the sentence it must not say.
 *
 * A non-ancestor reading is a fact about ONE ARTEFACT: the bundle was built
 * from a commit that does not contain yours. It is NOT the fact a reader wants,
 * which is *did my change ship*, and those come apart whenever a deploy
 * pipeline rebuilds artefacts by path.
 *
 * Measured on this repository 2026-09-03: the backend and worker deploy on
 * `packages/business/**` while every frontend deploys on the far narrower
 * `packages/business/shared/**`. So a change under `packages/business/domain/**`
 * ships to the backend and never rebuilds the app bundle — and the marker in
 * that bundle therefore CANNOT move, however correctly the change was deployed.
 *
 * This function used to render that as *"the deploy predates your change"*,
 * which is a claim about the deploy drawn from a measurement about one file:
 * the ticket's own defect, committed by the tool written to close it. The
 * direction is the kinder one — a false ALARM, never a false green — but a
 * reader who trusts the sentence goes hunting for a broken deploy that never
 * happened.
 *
 * So the message names BOTH readings and neither is presented as the default.
 * Deliberately NOT resolved here: doing that means reading the deploy
 * pipeline's path filters, which are specific to one repository's topology and
 * are not something a tool that takes an arbitrary URL can know.
 */
export function identityVerdict(want: string, served: string, contained: boolean): ArmVerdict {
  const pair = `${served.slice(0, 12)} / ${want.slice(0, 12)}`;
  return contained
    ? { arm: 'identity', state: 'pass', detail: `served commit ${pair} — contained` }
    : {
        arm: 'identity',
        state: 'fail',
        detail: `this artefact was built from ${served.slice(0, 12)}, which does NOT contain ${want.slice(0, 12)}. TWO READINGS, and they are not the same thing: (a) your change is not deployed, or (b) it IS deployed and touched no path that rebuilds THIS artefact, so the bundle was never rebuilt and its marker could not move. Ask whether your diff reaches this artefact's build inputs before reading this as a failed deploy`,
      };
}

/**
 * DIFFERENCE — which hashes moved between two deployments, and which HELD.
 *
 * The reusable half of SC-821, and it came out of that run unplanned. Its
 * readings were:
 *
 *     deploy 2   /assets/index-Z15maWXx.js   /assets/index-BxnsOjfm.css
 *     deploy 3   /assets/index-BveKii2S.js   /assets/index-BxnsOjfm.css
 *
 * The CSS held while the JS moved, on a JS-only change — which rules out *every
 * hash moves every build* from inside the same fetch pair.
 *
 * **The artefact that must not move is NOT hardcoded, and the ticket's example
 * would have been wrong by the time this shipped**: measured 2026-09-03, the
 * live CSS had moved too (`BxnsOjfm` -> `CRthzVz9`), which is correct for a
 * later deploy that touched styles. So this reports both sets and lets the
 * caller name the invariant their own change could not have touched.
 *
 * `held` being EVERYTHING is the reading that says the comparison is void: the
 * two URLs served the same build, so nothing about a change can be concluded.
 */
export function manifestDiff(
  before: readonly string[],
  after: readonly string[]
): { moved: string[]; held: string[] } {
  const b = new Set(before);
  const a = new Set(after);
  return {
    moved: [
      ...new Set([...before.filter((x) => !a.has(x)), ...after.filter((x) => !b.has(x))]),
    ].sort(),
    held: after.filter((x) => b.has(x)).sort(),
  };
}

/**
 * The verdict a run reports, given every arm.
 *
 * `unverified` OUTRANKS `fail`, which is the direction that matters: a run that
 * could not read must not be quoted as one that read and found nothing. An
 * `unavailable` arm — a host that carries no commit marker — is neither, and
 * cannot on its own decide anything.
 */
export function worstOf(arms: readonly ArmVerdict[]): ArmState {
  if (arms.length === 0) return 'unverified';
  if (arms.some((a) => a.state === 'unverified')) return 'unverified';
  if (arms.some((a) => a.state === 'fail')) return 'fail';
  if (arms.some((a) => a.state === 'pass')) return 'pass';
  return 'unavailable';
}

/**
 * SC-821. Tests for the deploy probe's decision half.
 *
 * NOTHING HERE TOUCHES THE NETWORK, so the fixtures are the point: every arm is
 * exercised against a body constructed to have a known answer, rather than
 * against whatever a live deploy happens to be serving today. The live readings
 * that motivated each case are quoted in the case, dated, so a future reader can
 * tell a fixture that encodes a measurement from one that encodes a guess.
 *
 * EVERY MUST-BE-ABSENT ASSERTION HAS A MUST-BE-FOUND BESIDE IT. That is the
 * defect under test, applied to its own test file: a suite of arms that all
 * expect 0 passes identically over working logic and over logic that returns 0
 * for everything.
 */

import { describe, expect, test } from 'bun:test';

import {
  classifyIndex,
  classifyShape,
  countLiteral,
  extractAssets,
  extractPageCommit,
  extractRelease,
  extractVersionCommit,
  type Fetched,
  falsifierClause,
  identityVerdict,
  manifestDiff,
  signalVerdict,
  worstOf,
} from '../lib/deploy-probe.ts';

/** The opening of what `app.scani.xyz` actually returns for an unknown asset. */
const FALLBACK = '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />';
const REAL_JS = 'var ON=Object.defineProperty;var LN=(e,t,n)=>t in e?ON(e,t,{';

function fetched(over: Partial<Fetched>): Fetched {
  return {
    url: 'https://example.test/assets/index-Aaaaaaaa.js',
    status: 200,
    contentType: 'application/javascript',
    body: REAL_JS,
    ...over,
  };
}

describe('classifyShape — the arm that refuses', () => {
  // The control. Without it every case below passes over a function that
  // returns `fallback` unconditionally.
  test('real JavaScript is real, and carries its own byte count', () => {
    const v = classifyShape(fetched({}), FALLBACK);
    expect(v.kind).toBe('real');
    expect(v.kind === 'real' && v.bytes).toBe(REAL_JS.length);
  });

  // Measured 2026-09-03: index-BveKii2S.js and index-ZZZZfake0.js both returned
  // HTTP 200, text/html, and were byte-identical under `cmp`.
  test('byte-identity with an invented sibling is the fallback', () => {
    const v = classifyShape(
      fetched({ body: FALLBACK, contentType: 'application/javascript' }),
      FALLBACK
    );
    expect(v.kind).toBe('fallback');
    expect(v.kind === 'fallback' && v.why).toContain('invented sibling');
  });

  test('content-type text/html where JS was asked for is the fallback', () => {
    const v = classifyShape(fetched({ contentType: 'text/html; charset=utf-8' }), null);
    expect(v.kind).toBe('fallback');
  });

  test('an HTML opener is the fallback even with no control available', () => {
    // scani.xyz answers 404 for an invented path (measured 2026-09-03), so the
    // byte-identity tell is unavailable there and this one has to carry it.
    const v = classifyShape(fetched({ body: FALLBACK }), null);
    expect(v.kind).toBe('fallback');
    expect(v.kind === 'fallback' && v.why).toContain('HTML document');
  });

  test('a non-200 is unreachable, which is not the same as a fallback', () => {
    const v = classifyShape(fetched({ status: 404 }), FALLBACK);
    expect(v.kind).toBe('unreachable');
  });

  // The byte count is NOT a tell. SC-821 recorded the fallback at 3992 bytes;
  // it measured 5013 four days later. A body of the wrong length is still the
  // fallback, and a body of the "right" length is still real JavaScript.
  test('byte count is never the discriminator', () => {
    const padded = `${FALLBACK}${' '.repeat(1021)}`;
    expect(classifyShape(fetched({ body: padded }), FALLBACK).kind).toBe('fallback');
    expect(classifyShape(fetched({ body: REAL_JS.padEnd(FALLBACK.length) }), FALLBACK).kind).toBe(
      'real'
    );
  });
});

describe('signalVerdict — why alive is mandatory', () => {
  const base = {
    signal: 'typeCode==="fiat"',
    alive: 'typeCode',
    expect: 'present' as const,
    contrast: null,
  };

  // SC-821's own readings: deploy 2 signal=0 alive=2, deploy 3 signal=1 alive=3.
  test('a zero with a live alive arm is a MEASURED absence, not an unknown', () => {
    const v = signalVerdict({ ...base, signalCount: 0, aliveCount: 2 });
    expect(v.state).toBe('fail');
    expect(v.detail).toContain('MEASURED absence');
  });

  test('a zero with a dead alive arm is UNVERIFIED, and says so', () => {
    const v = signalVerdict({ ...base, signalCount: 0, aliveCount: 0 });
    expect(v.state).toBe('unverified');
    expect(v.detail).toContain('VOID');
  });

  test('expect absent inverts the fail, and still needs the alive arm', () => {
    expect(signalVerdict({ ...base, expect: 'absent', signalCount: 1, aliveCount: 3 }).state).toBe(
      'fail'
    );
    expect(signalVerdict({ ...base, expect: 'absent', signalCount: 0, aliveCount: 0 }).state).toBe(
      'unverified'
    );
  });

  // An alive arm that is not part of the signal goes on reading non-zero after
  // the signal moves, so it could never report a dead read — the defect this
  // function exists to prevent, one level in.
  test('an alive literal outside the signal is refused without a contrast', () => {
    const v = signalVerdict({ ...base, alive: 'React', signalCount: 0, aliveCount: 400 });
    expect(v.state).toBe('unverified');
    expect(v.detail).toContain('not a substring');
  });
});

describe('signalVerdict — a pass needs a falsifier (SC-1172)', () => {
  const read = (signalCount: number, aliveCount: number) => ({
    kind: 'read' as const,
    source: 'https://prev.example.test',
    signalCount,
    aliveCount,
  });

  // SC-1168's landing deploy, measured 2026-09-12: a module-level analytics
  // host constant is emitted whether or not analytics resolved, so the deploy
  // that shipped disabled read alive=2 and a present signal. That reading was
  // quoted as SERVED.
  const sc1168 = {
    signal: 'ingest.analytics.test',
    alive: 'analytics',
    expect: 'present' as const,
    signalCount: 1,
    aliveCount: 2,
  };

  test('a present signal with no contrast is UNVERIFIED, naming the falsifier NOT TAKEN', () => {
    const v = signalVerdict({ ...sc1168, contrast: null });
    expect(v.state).toBe('unverified');
    expect(v.detail).toContain('falsifier was NOT TAKEN');
  });

  test('an absent signal with no contrast is UNVERIFIED too — a typo reads 0 forever', () => {
    const v = signalVerdict({ ...sc1168, expect: 'absent', signalCount: 0, contrast: null });
    expect(v.state).toBe('unverified');
    expect(v.detail).toContain('NOT TAKEN');
  });

  // The defect itself: the pre-deploy bundle carries the constant as well.
  test('a signal that reads the same on the contrast is a constant, not evidence', () => {
    const v = signalVerdict({ ...sc1168, contrast: read(1, 2) });
    expect(v.state).toBe('unverified');
    expect(v.detail).toContain('constant');
  });

  // The control for the case above, and the SC-1168 arm that did settle it:
  // the key prefix 1 on the deploy, 0 on the pre-deploy bundle, vendor name 2 on both.
  test('a signal that moves between the two is a pass, with an independent alive token', () => {
    const v = signalVerdict({
      signal: 'key_',
      alive: 'analytics',
      expect: 'present',
      signalCount: 1,
      aliveCount: 2,
      contrast: read(0, 2),
    });
    expect(v.state).toBe('pass');
    expect(v.detail).toContain('contrast https://prev.example.test signal=0 alive=2');
  });

  test('expect absent wants the contrast to carry the signal', () => {
    const absent = { ...sc1168, expect: 'absent' as const, signalCount: 0 };
    expect(signalVerdict({ ...absent, contrast: read(3, 2) }).state).toBe('pass');
    expect(signalVerdict({ ...absent, contrast: read(0, 2) }).state).toBe('unverified');
  });

  test('a contrast whose alive reads 0 is a void read, whatever its signal says', () => {
    const v = signalVerdict({ ...sc1168, contrast: read(0, 0) });
    expect(v.state).toBe('unverified');
    expect(v.detail).toContain('VOID');
  });

  test('an unreadable contrast is UNVERIFIED and names why', () => {
    const v = signalVerdict({
      ...sc1168,
      contrast: { kind: 'unreadable', source: 'dist/', why: 'ENOENT' },
    });
    expect(v.state).toBe('unverified');
    expect(v.detail).toContain('ENOENT');
  });

  // A fail is a measured absence however little the signal discriminates, and
  // its error direction is a false alarm; it needs no falsifier.
  test('a measured fail needs no contrast', () => {
    expect(signalVerdict({ ...sc1168, signalCount: 0, contrast: null }).state).toBe('fail');
  });

  test('the verdict clause says which falsifier was taken, including none', () => {
    expect(falsifierClause(null)).toContain('NOT TAKEN');
    expect(falsifierClause(read(0, 2))).toBe(
      'signal falsifier https://prev.example.test signal=0 alive=2'
    );
    expect(falsifierClause({ kind: 'unreadable', source: 'dist/', why: 'ENOENT' })).toContain(
      'UNREADABLE'
    );
  });
});

describe('extractRelease — unavailable is not absent', () => {
  // Measured 2026-09-03 on the live app.scani.xyz entry chunk.
  test('finds the commit a build was made from', () => {
    expect(extractRelease('x,release:"cee35445753d2c8ecc3f4606fc0fbcf7772a6935",y')).toBe(
      'cee35445753d2c8ecc3f4606fc0fbcf7772a6935'
    );
  });

  // The Sentry SDK's own minified source contains these. Matching them would
  // manufacture a commit out of the vendored library on every host.
  test('the SDK’s own release plumbing is not a marker', () => {
    expect(extractRelease('t.release&&(e.release=t.release),attrs:{release:e.release}')).toBeNull();
  });

  test('a bundle with no marker reads null, which the caller must render as unavailable', () => {
    // scani.xyz and cloud.scani.xyz, measured 2026-09-03: real JS, no marker,
    // because their deploys pass no Sentry DSN.
    expect(extractRelease(REAL_JS)).toBeNull();
  });

  test('a short hex string is not a commit', () => {
    expect(extractRelease('release:"cee3544"')).toBeNull();
  });
});

describe('extractPageCommit — a static site names its own commit (SC-995)', () => {
  const SHA = 'cee35445753d2c8ecc3f4606fc0fbcf7772a6935';

  test('finds the marker the docs build writes into every page', () => {
    const html = `<head><meta charset="utf-8"><meta name="scani-commit" content="${SHA}"></head>`;
    expect(extractPageCommit(html)).toBe(SHA);
  });

  test('attribute order is not a contract', () => {
    expect(extractPageCommit(`<meta content="${SHA}" name="scani-commit"/>`)).toBe(SHA);
  });

  // The control for the case above: a 40-hex content on some OTHER meta must
  // not be read as the commit, or any page with a hash in its head would pass.
  test('another meta carrying a hash is not the marker', () => {
    expect(extractPageCommit(`<meta name="generator" content="${SHA}">`)).toBeNull();
  });

  test('a page with no marker reads null — a pre-SC-995 build, not an absent commit', () => {
    expect(extractPageCommit('<head><meta name="generator" content="Astro v6"></head>')).toBeNull();
  });

  test('a short sha is not a commit', () => {
    expect(extractPageCommit('<meta name="scani-commit" content="cee3544">')).toBeNull();
  });
});

describe('extractVersionCommit — every Vite site names its commit (SC-964)', () => {
  const SHA = 'cee35445753d2c8ecc3f4606fc0fbcf7772a6935';
  const json = (body: string, over: Partial<Fetched> = {}): Fetched =>
    fetched({
      url: 'https://example.test/version.json',
      contentType: 'application/json',
      body,
      ...over,
    });

  test('finds the commit the build plugin writes', () => {
    expect(
      extractVersionCommit(
        json(`{"version":"1-abc","buildTime":"2026-09-11T10:00:00.000Z","commit":"${SHA}"}`)
      )
    ).toBe(SHA);
  });

  // app.scani.xyz answers an unknown path with index.html at 200, so a site
  // with no version.json hands back HTML — and that must not parse as a commit
  // even when the page happens to carry one.
  test('the SPA fallback is not a payload, even when it names a commit', () => {
    const html = `<!doctype html><meta name="scani-commit" content="${SHA}">`;
    expect(
      extractVersionCommit(json(html, { contentType: 'text/html; charset=utf-8' }))
    ).toBeNull();
    expect(extractVersionCommit(json(html))).toBeNull();
  });

  test('a pre-SC-964 payload names no commit — unavailable, not absent', () => {
    expect(extractVersionCommit(json('{"version":"1-abc","buildTime":"x"}'))).toBeNull();
  });

  test('a short or non-string commit is not a commit', () => {
    expect(extractVersionCommit(json('{"commit":"cee3544"}'))).toBeNull();
    expect(extractVersionCommit(json('{"commit":42}'))).toBeNull();
    expect(extractVersionCommit(json('null'))).toBeNull();
  });

  test('a non-200 reads nothing, whatever the body says', () => {
    expect(extractVersionCommit(json(`{"commit":"${SHA}"}`, { status: 404 }))).toBeNull();
  });
});

describe('countLiteral', () => {
  test('counts non-overlapping occurrences', () => {
    expect(countLiteral('aXbXc', 'X')).toBe(2);
    expect(countLiteral('aaaa', 'aa')).toBe(2);
    expect(countLiteral('abc', 'z')).toBe(0);
  });

  // The signal is a code shape, so it is full of characters a regex would read
  // as syntax. Treating it as a pattern would silently match the wrong thing.
  test('regex metacharacters are literal', () => {
    expect(countLiteral('t.typeCode==="fiat"?a:b', 'typeCode==="fiat"')).toBe(1);
    expect(countLiteral('typeCodeXXXfiat', 'typeCode==="fiat"')).toBe(0);
    expect(countLiteral('a+b', 'a+b')).toBe(1);
  });

  test('an empty needle counts nothing rather than everything', () => {
    expect(countLiteral('abc', '')).toBe(0);
  });
});

describe('identityVerdict — the sentence it must not say', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);

  test('contained is a pass', () => {
    expect(identityVerdict(A, B, true).state).toBe('pass');
  });

  // SC-1185: a rollback replaces a newer build, which contains its target.
  test('exact: a containing but different commit fails; the commit itself passes', () => {
    const v = identityVerdict(A, B, true, true);
    expect(v.state).toBe('fail');
    expect(v.detail).toContain('CONTAINS');
    expect(identityVerdict(A, A, true, true).state).toBe('pass');
    expect(identityVerdict(A, B, false, true).state).toBe('fail');
  });

  test('not contained is a fail, because the artefact really was read', () => {
    expect(identityVerdict(A, B, false).state).toBe('fail');
  });

  // The reason this is pinned rather than left to review. A non-ancestor
  // reading is a fact about ONE ARTEFACT, and it is NOT the fact the reader
  // wants. Measured on this repository 2026-09-03: the backend and worker
  // deploy on `packages/business/**` while every frontend deploys on
  // `packages/business/shared/**`, so a change under
  // `packages/business/domain/**` ships to the backend and never rebuilds the
  // app bundle — whose marker therefore cannot move, however correct the
  // deploy was.
  //
  // The message used to read "the deploy predates your change": a claim about
  // the deploy drawn from a measurement about one file, which is this file's
  // own defect. A reader who trusts it hunts for a broken deploy that never
  // happened. Simplifying the message back to one reading is the regression.
  test('a fail names BOTH readings and presents neither as the default', () => {
    const d = identityVerdict(A, B, false).detail;
    expect(d).toContain('TWO READINGS');
    expect(d).toContain('not deployed');
    expect(d).toContain('rebuilds THIS artefact');
    expect(d).not.toContain('the deploy predates your change');
  });
});

describe('classifyIndex — the arm that must NOT be the shape arm', () => {
  // The bug this pins, found 2026-09-03 by exercising `--against` live for the
  // first time. `classifyShape` treats `text/html` as the tell that an ASSET
  // request was answered by the fallback. Pointed at an INDEX document that
  // content-type is simply correct, so the difference arm reported UNVERIFIED
  // against three perfectly good deployments in a row — this ticket's own
  // defect, in the tool written to close it, in the one arm never run live.
  test('a healthy index is text/html and must still read as an index', () => {
    const v = classifyIndex({
      url: 'https://example.test/',
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><script src="/assets/index-Aa1.js"></script>',
    });
    expect(v.kind).toBe('index');
    expect(v.kind === 'index' && v.assets).toEqual(['/assets/index-Aa1.js']);
  });

  // The tell that survives: references, not content-type.
  test('a document referencing no assets is not an index, whatever its type', () => {
    const v = classifyIndex({
      url: 'https://example.test/version.json',
      status: 200,
      contentType: 'application/json',
      body: '{"version":"x"}',
    });
    expect(v.kind).toBe('not-an-index');
    expect(v.kind === 'not-an-index' && v.why).toContain('no /assets/*');
  });

  test('a non-200 is not an index', () => {
    const v = classifyIndex({
      url: 'https://example.test/',
      status: 404,
      contentType: 'text/html',
      body: '<!doctype html><script src="/assets/index-Aa1.js"></script>',
    });
    expect(v.kind).toBe('not-an-index');
  });
});

describe('extractAssets and manifestDiff', () => {
  const html =
    '<script src="/assets/index-Dbaproc5.js"></script><link href="/assets/index-CRthzVz9.css">';

  test('reads both js and css references, deduplicated', () => {
    expect(extractAssets(`${html}${html}`)).toEqual([
      '/assets/index-CRthzVz9.css',
      '/assets/index-Dbaproc5.js',
    ]);
  });

  // SC-821's own pair: the CSS HELD while the JS moved, on a JS-only change.
  test('reports moved and held separately', () => {
    const d = manifestDiff(
      ['/assets/index-Z15maWXx.js', '/assets/index-BxnsOjfm.css'],
      ['/assets/index-BveKii2S.js', '/assets/index-BxnsOjfm.css']
    );
    expect(d.moved).toEqual(['/assets/index-BveKii2S.js', '/assets/index-Z15maWXx.js']);
    expect(d.held).toEqual(['/assets/index-BxnsOjfm.css']);
  });

  // The ticket named the CSS as the must-not-move artefact. By 2026-09-03 the
  // live CSS had moved too, correctly, for a later deploy that touched styles —
  // so nothing is hardcoded and both sets are reported.
  test('everything moving is a legitimate reading, not an error', () => {
    const d = manifestDiff(
      ['/assets/a-1.js', '/assets/a-1.css'],
      ['/assets/a-2.js', '/assets/a-2.css']
    );
    expect(d.held).toEqual([]);
    expect(d.moved).toHaveLength(4);
  });

  test('nothing moving means the comparison is void', () => {
    const d = manifestDiff(['/assets/a-1.js'], ['/assets/a-1.js']);
    expect(d.moved).toEqual([]);
    expect(d.held).toEqual(['/assets/a-1.js']);
  });
});

describe('worstOf', () => {
  const arm = (state: 'pass' | 'fail' | 'unverified' | 'unavailable') => ({
    arm: 'x',
    state,
    detail: '',
  });

  // The direction that matters: a run that could not read must never be quoted
  // as one that read and found nothing.
  test('unverified outranks fail', () => {
    expect(worstOf([arm('pass'), arm('fail'), arm('unverified')])).toBe('unverified');
  });

  test('fail outranks pass', () => {
    expect(worstOf([arm('pass'), arm('fail')])).toBe('fail');
  });

  test('an unavailable arm cannot on its own decide anything', () => {
    expect(worstOf([arm('unavailable')])).toBe('unavailable');
    expect(worstOf([arm('unavailable'), arm('pass')])).toBe('pass');
  });

  test('no arms at all is unverified, never a pass', () => {
    expect(worstOf([])).toBe('unverified');
  });
});

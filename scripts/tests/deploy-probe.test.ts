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
  extractRelease,
  type Fetched,
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
  const base = { signal: 'typeCode==="fiat"', alive: 'typeCode', expect: 'present' as const };

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

  test('found is found', () => {
    expect(signalVerdict({ ...base, signalCount: 1, aliveCount: 3 }).state).toBe('pass');
  });

  test('expect absent inverts the verdict, and still needs the alive arm', () => {
    expect(signalVerdict({ ...base, expect: 'absent', signalCount: 0, aliveCount: 2 }).state).toBe(
      'pass'
    );
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
  test('an alive literal outside the signal is refused, however healthy it looks', () => {
    const v = signalVerdict({
      signal: 'typeCode==="fiat"',
      alive: 'React',
      expect: 'present',
      signalCount: 0,
      aliveCount: 400,
    });
    expect(v.state).toBe('unverified');
    expect(v.detail).toContain('not a substring');
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

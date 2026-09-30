import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { captureContextQuery } from '../../../src/v3/lib/capture';
import { parsePaymentSheet, V3_PAYMENT_ROUTES } from '../../../src/v3/lib/routes';

/**
 * Every query parameter a v3 screen reads must be one some v3 screen writes.
 *
 * This is the shape of the V3-46 defect, and the reason it survived a type
 * check, a lint pass and a full test suite: `PaymentFormPage` read
 * `?fromExtraction=`, fetched the extraction, prefilled twelve fields and
 * routed the submit through `payments.createFromExtraction` — all of it
 * correct, all of it covered, and *nothing in v3 ever produced the link*. The
 * only writer was v2's document page. A consumer with no producer is dead code
 * that looks alive: it compiles, it is exercised by its own unit tests, and the
 * feature it implements is unreachable.
 *
 * Nothing else in the toolchain can see this. `knip` finds unused exports, not
 * unused URLs; TypeScript has no opinion about the contents of a string. So the
 * check is a source scan, deliberately: it asserts a property of the *app*, not
 * of a module, and there is no module to hang it off.
 */

const V3_ROOT = join(import.meta.dir, '../../../src/v3');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

/**
 * Comments are stripped before anything is matched, and that is not tidiness.
 * Every file in v3 carries a paragraph explaining itself, and this very defect
 * is *described* in prose in `UiVersionGate` and `capture.ts` — so a scan that
 * read comments would find `?fromExtraction=` in a sentence about the bug and
 * declare the link produced. The guard has to see code only.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const FILES = sourceFiles(V3_ROOT).map((path) => ({
  path,
  relative: path.slice(V3_ROOT.length + 1),
  source: stripComments(readFileSync(path, 'utf8')),
}));

/**
 * A read of a *named* parameter. Screens that read their filters from an
 * exported list (`HOLDING_FILTER_PARAMS`, `ACCOUNT_FILTER_PARAMS`) go through
 * `params.get(key)` with a variable and are not matched here — correctly, since
 * those keys are a shared spelling contract with v2 rather than a link one v3
 * surface hands another, and the refine sheet writes them back generically.
 */
const CONSUMER = /searchParams\.get\(\s*'([^']+)'\s*\)/g;

/** A link literal: `?key=` or `&key=`, in a template string or a plain one. */
function producesKey(source: string, key: string): boolean {
  return source.includes(`?${key}=`) || source.includes(`&${key}=`);
}

/**
 * Keys written through an allow-list rather than spelled into a URL —
 * `captureContextQuery` builds its query with `URLSearchParams.set(key, …)`
 * over a list, so no literal `?accountId=` exists anywhere to grep for. Asking
 * the function what it forwards is both simpler and stricter than a regex that
 * would have to understand the loop.
 */
const FORWARDED_KEYS: readonly string[] = [
  ...new URLSearchParams(
    captureContextQuery(
      new URLSearchParams({ accountId: 'probe', institutionId: 'probe', peek: 'probe' })
    )
  ).keys(),
];

interface Consumption {
  key: string;
  relative: string;
}

const CONSUMED: Consumption[] = FILES.flatMap((file) =>
  [...file.source.matchAll(CONSUMER)].map((match) => ({
    key: match[1] as string,
    relative: file.relative,
  }))
);

describe('v3 query parameters', () => {
  // A guard that matches nothing passes forever. This is the canary: if the
  // regex or the layout changes, this fails before the real assertion goes
  // quietly green.
  test('the scan actually finds the parameters v3 reads', () => {
    expect(CONSUMED.length).toBeGreaterThan(0);
    // `fromExtraction` was the example until SC-1414 moved it into the bill
    // sheet's `sheet` value; `accountId` is a reader still in the tree.
    expect(CONSUMED.map((c) => c.key)).toContain('accountId');
  });

  test('every parameter a v3 screen reads is written by a v3 screen', () => {
    const orphans = CONSUMED.filter(
      (consumption) =>
        !FORWARDED_KEYS.includes(consumption.key) &&
        !FILES.some(
          (file) =>
            file.relative !== consumption.relative && producesKey(file.source, consumption.key)
        )
    );

    expect(orphans).toEqual([]);
  });
});

describe('the invoice → payment bridge', () => {
  /**
   * The two halves stated against each other rather than against a literal.
   * `V3_PAYMENT_ROUTES.fromExtraction` is the producer and `parsePaymentSheet`
   * — what `PaymentFormSheet` opens from — is the consumer; the form became a
   * sheet in SC-1414, so the extraction id rides in the `sheet` value now. A
   * rename on either side is exactly how this breaks again.
   */
  test('the route helper writes the sheet value the form reads', () => {
    const url = new URL(V3_PAYMENT_ROUTES.fromExtraction('abc-123'), 'https://app.scani.xyz');
    expect(url.pathname).toBe('/payments');
    expect(parsePaymentSheet(url.searchParams.get('sheet'))).toEqual({
      mode: 'invoice',
      extractionId: 'abc-123',
    });
  });

  test('the id is encoded rather than interpolated raw', () => {
    const url = new URL(V3_PAYMENT_ROUTES.fromExtraction('a b&c=d'), 'https://app.scani.xyz');
    expect(parsePaymentSheet(url.searchParams.get('sheet'))).toEqual({
      mode: 'invoice',
      extractionId: 'a b&c=d',
    });
  });
});

describe('capture context', () => {
  /**
   * The other producer in v3, and the reason the orphan check above passes for
   * `accountId` / `institutionId`: they are forwarded by an allow-list rather
   * than written as a literal, so the test calls the function instead of
   * grepping for the string.
   */
  test('forwards exactly the two keys the capture forms read', () => {
    const query = captureContextQuery(
      new URLSearchParams({ accountId: 'acc-1', institutionId: 'inst-1', fromExtraction: 'x' })
    );
    const params = new URLSearchParams(query);
    expect(params.get('accountId')).toBe('acc-1');
    expect(params.get('institutionId')).toBe('inst-1');
    expect(params.get('fromExtraction')).toBeNull();
  });
});

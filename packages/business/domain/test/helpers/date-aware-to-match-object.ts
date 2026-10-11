import { expect } from 'bun:test';

type Mismatch = { path: string; expected: Date; received: unknown };

function dateMismatches(expected: unknown, received: unknown, path: string, out: Mismatch[]): void {
  if (expected instanceof Date) {
    const same = received instanceof Date && Object.is(received.getTime(), expected.getTime());
    if (!same) out.push({ path, expected, received });
    return;
  }
  if (expected === null || typeof expected !== 'object') return;
  if (typeof (expected as { asymmetricMatch?: unknown }).asymmetricMatch === 'function') return;
  const rec = received !== null && typeof received === 'object' ? received : undefined;
  if (Array.isArray(expected)) {
    for (const [i, v] of expected.entries()) {
      dateMismatches(v, Array.isArray(rec) ? rec[i] : undefined, `${path}[${i}]`, out);
    }
    return;
  }
  for (const key of Object.keys(expected)) {
    dateMismatches(
      (expected as Record<string, unknown>)[key],
      rec ? (rec as Record<string, unknown>)[key] : undefined,
      `${path}.${key}`,
      out
    );
  }
}

const show = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

let installed = false;

// bun's `toMatchObject` passes two different `Date`s: 33 call sites expected
// one and none of them could have failed on it (SC-1568). This keeps bun's
// verdict and also fails when a `Date` in the expected object differs.
export function installDateAwareToMatchObject(): void {
  if (installed) return;
  installed = true;
  const builtin = Object.getPrototypeOf(expect(0)).toMatchObject as (
    this: unknown,
    expected: unknown
  ) => void;
  expect.extend({
    toMatchObject(received: unknown, expected: unknown) {
      try {
        builtin.call(expect(received), expected);
      } catch (err) {
        return { pass: false, message: () => (err instanceof Error ? err.message : String(err)) };
      }
      const mismatches: Mismatch[] = [];
      dateMismatches(expected, received, '', mismatches);
      if (mismatches.length === 0) {
        return { pass: true, message: () => 'expected the object not to match, and it did' };
      }
      return {
        pass: false,
        message: () =>
          `toMatchObject: Date mismatch (SC-1568)\n${mismatches
            .map(
              (m) =>
                `  ${m.path || '(root)'}: expected ${show(m.expected)}, received ${show(m.received)}`
            )
            .join('\n')}`,
      };
    },
  });
}

import { describe, expect, test } from 'bun:test';

const HOOK = 'apps/frontend/app/src/v3/hooks/useHomeChart.ts';
const BLOCK = 'apps/frontend/app/src/v3/components/home/ReturnsBlock.tsx';

async function read(path: string): Promise<string> {
  const text = await Bun.file(path).text();
  // The control: every assertion below is an ABSENCE-shaped claim about a file
  // this test names by path, so a rename would pass all of them silently.
  expect(text.length).toBeGreaterThan(0);
  return text;
}

/** `trpc.<path>.useQuery(` … up to the call's closing paren. */
function callTo(source: string, procedure: string): string {
  const start = source.indexOf(`trpc.${procedure}.useQuery(`);
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = source.indexOf('(', start); i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced call for ${procedure}`);
}

describe('the returns engine is not on Home’s critical path', () => {
  test('useHomeChart asks the one-bit probe and gates the engine on it', async () => {
    const source = await read(HOOK);
    expect(source).toInclude('trpc.portfolio.hasReturns.useQuery');
    expect(callTo(source, 'portfolio.getReturns')).toInclude('enabled:');
  });

  test('ReturnsBlock gates BOTH engine calls on the same probe', async () => {
    const source = await read(BLOCK);
    expect(source).toInclude('trpc.portfolio.hasReturns.useQuery');
    expect(callTo(source, 'portfolio.getReturns')).toInclude('enabled:');
    expect(callTo(source, 'portfolio.getReturnsComparison')).toInclude('hasHistory');
  });

  test('the probe itself is NOT gated — it is what every load pays instead', async () => {
    // The control that keeps the two assertions above from being satisfied by
    // gating everything off: a probe behind an `enabled` answers nothing and
    // the tab would never be offered.
    const source = await read(HOOK);
    expect(callTo(source, 'portfolio.hasReturns')).not.toInclude('enabled:');
  });
});

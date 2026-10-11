import { describe, expect, test } from 'bun:test';
import { TOOL_OUTPUTS } from '../../src/mcp/outputs';
import { MCP_TOOLS } from '../../src/mcp/tools';

// SC-1645: get_returns carries the window's gains grouped by the bucket of
// each account's wrapper, in a shape its declared output takes.

const tool = MCP_TOOLS.find((candidate) => candidate.name === 'get_returns');
const bucket = (treatment: string) => ({
  treatment,
  realized: '1.5',
  unrealized: '-2',
  accountCount: 1,
});

function caller(gains: unknown) {
  return {
    portfolio: {
      getReturns: async () => ({ benchmarks: [] }),
      getGainsByWrapper: async (input: unknown) => {
        expect(input).toEqual({ window: { kind: 'ytd' } });
        return gains;
      },
    },
  } as never;
}

describe('get_returns gains_by_treatment', () => {
  test('carries all four buckets, and the declared output takes it', async () => {
    const gains = {
      status: 'ok',
      buckets: ['general', 'deferred', 'exempt', 'advantaged'].map(bucket),
      anyWrapped: true,
      carriedHoldings: 0,
    };
    const out = (await tool?.run(caller(gains), { window: 'ytd' })) as Record<string, unknown>;
    expect(out.gains_by_treatment).toEqual(gains);
    expect(TOOL_OUTPUTS.get_returns?.safeParse(out).success).toBe(true);
  });

  test('a rebuild in flight is said, not filled with figures', async () => {
    const out = (await tool?.run(caller({ status: 'rebuilding', anyWrapped: true }), {
      window: 'ytd',
    })) as Record<string, unknown>;
    expect(out.gains_by_treatment).toEqual({ status: 'rebuilding', anyWrapped: true });
    expect(TOOL_OUTPUTS.get_returns?.safeParse(out).success).toBe(true);
  });
});

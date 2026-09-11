import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * SC-980 — the cost-basis method can only be written by a person who confirmed
 * it, and this is the guard that says so mechanically.
 *
 * ## What is actually at stake
 *
 * A change to `users.cost_basis_method` busts the live valuation cache and
 * enqueues a backfill across the whole `PORTFOLIO_HISTORY_LOOKBACK_DAYS`
 * window; every `portfolio_value_daily` row it touches carries cost basis and
 * realized PnL and is rewritten. Before any UI existed, changing it took an
 * API call — which nobody does by accident. **A control that saved itself on a
 * timer would therefore be a REGRESSION on having no control at all**, and the
 * regression would be invisible: the write succeeds, the page looks fine, and
 * a year of the reader's realized gains has moved.
 *
 * `ProfileSettings` is exactly that shape and is right to be: it fires
 * `updateCurrent` one second after the last keystroke. So the two blocks sit
 * next to each other on one screen, one of them auto-saving and one of them
 * that must never — which is a distinction review is bad at holding and a test
 * is good at.
 *
 * ## The control
 *
 * Every assertion here is an ABSENCE, and an absence is worth nothing unless
 * the search that produced it could have found something. So the auto-saving
 * block is located by the same reading first: if `ProfileSettings` ever stops
 * looking like a timer-driven save, this file says so rather than quietly
 * passing over a tree it can no longer see.
 */

const V3 = resolve(import.meta.dir, '../../../src/v3');
const PROFILE = join(V3, 'components/settings/ProfileSettings.tsx');
const COST_BASIS = join(V3, 'components/settings/CostBasisSettings.tsx');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const read = (file: string) => readFileSync(file, 'utf8');

describe('the auto-saving block cannot reach the cost-basis method', () => {
  test('CONTROL: ProfileSettings does save on a timer, with no button', () => {
    // If this stops being true the absence below stops being a finding — it
    // would just mean the shape this file is looking for has moved.
    const src = read(PROFILE);
    expect(src).toInclude('setTimeout(');
    expect(src).toInclude('AUTOSAVE_DELAY_MS');
    expect(src).toInclude('mutate(');
  });

  test('and it never names the cost-basis method', () => {
    const src = read(PROFILE);
    expect(src).not.toInclude('costBasisMethod');
    // The reading is real: the field it DOES auto-save is right there.
    expect(src).toInclude('baseCurrencyId');
  });
});

describe('exactly one surface writes the method, and only on confirm', () => {
  /** Every v3 file that puts `costBasisMethod` into a mutation payload. */
  const writers = sources(V3)
    .filter((file) => /costBasisMethod:\s/.test(read(file)))
    .map((file) => relative(V3, file))
    .sort();

  test('one file, and it is the confirmed one', () => {
    expect(writers).toEqual(['components/settings/CostBasisSettings.tsx']);
  });

  test('that file has no timer to save on', () => {
    expect(read(COST_BASIS)).not.toInclude('setTimeout(');
  });

  test('its single write sits inside the confirmation handler', () => {
    const src = read(COST_BASIS);
    const mutations = src.match(/\.mutate\(/g) ?? [];
    // More than one and the reasoning below covers only the first of them.
    expect(mutations).toHaveLength(1);

    const confirm = src.indexOf('onConfirm={');
    const write = src.indexOf('.mutate(');
    expect(confirm).toBeGreaterThan(-1);
    // The write is lexically inside `onConfirm`, which `ConfirmAction` renders
    // only once the block is open — so there is no path from the resting
    // screen to the enqueue that does not pass the consequence sentence.
    expect(write).toBeGreaterThan(confirm);
  });

  test('the commit is refused until the choice is an actual change', () => {
    // `canConfirm` is what stops a confirmation being offered for a write the
    // database would refuse; `costBasisChangeRequest` is the decision behind
    // it and is tested on both arms in `tests/v3/lib/cost-basis.test.ts`.
    const src = read(COST_BASIS);
    expect(src).toInclude('canConfirm={requested !== null}');
  });

  test('the running state is read from the server, not remembered by the tab', () => {
    // A job id held in React state is lost by a reload — which is precisely
    // when a page mid-rewrite would read as finished.
    const src = read(COST_BASIS);
    expect(src).toInclude('state?.recomputingJobId');
    expect(src).not.toInclude('setJobId');
  });
});

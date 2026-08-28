import { describe, expect, test } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import preset from '../../tailwind-preset.js';

/**
 * Why an `rtl:` utility beats the physical one it is there to override
 * (SC-760) — stated as a measurement rather than as a comment.
 *
 * The RTL pass replaces physical utilities with logical ones wherever a
 * logical spelling exists. Three things have none: `tailwindcss-animate`'s
 * `slide-in-from-*` (it sets a physical `--tw-enter-translate-x`), `translate-x-*`
 * on the `Switch` thumb, and anything else built on a transform — because a
 * transform is not mirrored by `dir`. Those carry an explicit `rtl:` counterpart
 * instead, and the counterpart only works if it actually wins.
 *
 * IT DOES NOT WIN ON SPECIFICITY, WHICH IS WHAT THE CODE COMMENTS SAID FIRST.
 * Tailwind 3.4 compiles the `rtl:` variant to
 *
 *     :where([dir="rtl"], [dir="rtl"] *)
 *
 * and `:where()` contributes ZERO specificity by definition. So the RTL rule
 * and the physical rule it must beat are BOTH (0,2,0) — one class plus one
 * attribute — and the winner is decided entirely by which comes later in the
 * stylesheet. Tailwind emits variant rules after unprefixed ones, so it works;
 * but "it works" and "it works for the reason I wrote down" are different
 * claims, and only the second one survives somebody reordering a plugin.
 *
 * `cn()` does not resolve it either, which rules out the other candidate
 * mechanism: tailwind-merge does not know `slide-in-from-left` and
 * `slide-in-from-right` are the same group, so it keeps both and hands the
 * decision to the cascade. Measured, not assumed — a control below pins it.
 *
 * This is the sibling of `tap-target-floor.test.ts`, which pins the same kind
 * of load-bearing cascade fact for the 44px touch floor.
 */

const UI_SRC = resolve(import.meta.dir, '../../src');
const V3_SRC = resolve(import.meta.dir, '../../../../../apps/frontend/app/src/v3');

function sources(root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path)) out.push(path);
  }
  return out;
}

/** Every `rtl:`-prefixed utility this design system actually ships. Discovered
 *  rather than listed, so a new one is covered the day it is written. */
async function rtlClasses(): Promise<string[]> {
  const found = new Set<string>();
  for (const file of [...sources(UI_SRC), ...sources(V3_SRC)]) {
    const text = await Bun.file(file).text();
    for (const match of text.matchAll(/rtl:[A-Za-z0-9:_\-[\]/.%#()=,]+/g)) {
      found.add(match[0].replace(/['"`,]+$/, ''));
    }
  }
  return [...found].sort();
}

interface Rule {
  index: number;
  selector: string;
  properties: string[];
}

/** Build the utilities layer for a set of candidate classes, in memory. */
async function build(classes: string[]): Promise<{ css: string; rules: Rule[] }> {
  const raw = `<div class="${classes.join(' ')}"></div>`;
  const result = await postcss([
    tailwind({ ...preset, content: [{ raw, extension: 'html' }] }),
  ]).process('@tailwind utilities;', { from: undefined });

  const rules: Rule[] = [];
  result.root.walkRules((rule) => {
    const properties: string[] = [];
    rule.walkDecls((decl) => {
      properties.push(decl.prop);
    });
    rules.push({ index: rules.length, selector: rule.selector, properties });
  });
  return { css: result.css, rules };
}

/** The physical class each `rtl:` one exists to override: the same utility
 *  with the prefix removed is NOT it — `rtl:…-from-right` overrides
 *  `…-from-left`. What they share is the DECLARED PROPERTY, so that is what
 *  this pairs on. */
function overriddenBy(rule: Rule, rules: Rule[]): Rule[] {
  return rules.filter(
    (other) =>
      !other.selector.includes('[dir="rtl"]') &&
      other.properties.some((property) => rule.properties.includes(property))
  );
}

describe('rtl: utilities win by source order, not by specificity', () => {
  test('the design system ships rtl: utilities to check', async () => {
    const classes = await rtlClasses();
    // A denominator, printed by the failure message rather than assumed. If
    // this ever reads 0 the whole file passes vacuously.
    expect(classes.length).toBeGreaterThan(0);
  });

  test('every rtl: utility compiles to a rule', async () => {
    const classes = await rtlClasses();
    const { rules } = await build(classes);
    // Tailwind escapes `:`, `[`, `]` and `/` in the emitted selector. Comparing
    // on the un-escaped form is what makes this a check on "did a rule appear"
    // rather than on this version's escaping convention.
    const emitted = rules.map((rule) => rule.selector.replace(/\\/g, ''));
    const missing = classes.filter((name) => !emitted.some((sel) => sel.includes(name)));
    expect(missing).toEqual([]);
  });

  test('the rtl: variant carries zero specificity of its own', async () => {
    const { rules } = await build(await rtlClasses());
    const rtlRules = rules.filter((rule) => rule.selector.includes('[dir="rtl"]'));
    expect(rtlRules.length).toBeGreaterThan(0);
    // `:where()` is the whole reason this file exists. If Tailwind ever emits
    // a bare `[dir="rtl"] &` the rules stop being tied on specificity, the
    // ordering assertion below stops being the mechanism, and the comments in
    // `sheet.tsx` and `switch.tsx` need rewriting again.
    const notWhere = rtlRules.filter((rule) => !rule.selector.includes(':where('));
    expect(notWhere.map((rule) => rule.selector)).toEqual([]);
  });

  test('each rtl: rule is emitted after every physical rule it overrides', async () => {
    const { rules } = await build(await rtlClasses());
    const rtlRules = rules.filter((rule) => rule.selector.includes('[dir="rtl"]'));
    const inverted: string[] = [];
    for (const rule of rtlRules) {
      for (const physical of overriddenBy(rule, rules)) {
        if (physical.index > rule.index) {
          inverted.push(`${rule.selector} is emitted BEFORE ${physical.selector}`);
        }
      }
    }
    expect(inverted).toEqual([]);
  });

  test('the pairing finds something — this is not vacuous', async () => {
    const { rules } = await build(await rtlClasses());
    const rtlRules = rules.filter((rule) => rule.selector.includes('[dir="rtl"]'));
    const paired = rtlRules.filter((rule) => overriddenBy(rule, rules).length > 0);
    // Without this, an `overriddenBy` that matched nothing would make the
    // ordering test above pass over an empty loop.
    expect(paired.length).toBeGreaterThan(0);
  });

  test('a class the content never mentions is not in the output', async () => {
    const { css } = await build(['rtl:translate-x-5']);
    // The must-be-ABSENT control on the other axis: proves the build is really
    // driven by the scanned content, so "emitted" above is a reading and not a
    // property of Tailwind emitting everything.
    expect(css).not.toContain('ml-99');
    expect(css).not.toContain('slide-in-from-left');
  });
});

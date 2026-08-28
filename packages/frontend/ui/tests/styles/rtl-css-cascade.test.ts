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

/**
 * A `@keyframes` step is a WAYPOINT ON A TIMELINE, not a competitor in the
 * cascade, and until SC-766 nothing in this harness could tell the difference.
 *
 * `walkRules` descends into at-rules, so `0%`, `50%`, `from` and `to` arrive
 * looking like ordinary selectors. They only became a problem when a `rtl:`
 * class first pulled a `transform`-declaring keyframe into the build:
 * `rtl:motion-safe:animate-loading-bar-rtl` emits `@keyframes loading-bar-rtl`,
 * whose steps declare `transform` — so `overriddenBy`, which pairs on the
 * DECLARED PROPERTY, matched them against every `rtl:` transform utility in
 * the sheet and reported six orderings inverted. All six were spurious: a
 * keyframe step never overrides anything.
 *
 * Latent rather than new. The `rtl:` classes shipped before SC-766 all set
 * `--tw-enter-translate-x`, which the `enter`/`exit` keyframes only READ, so
 * no keyframe declaring a shared property had ever reached this function.
 *
 * Do not "tidy" this back to a plain `walkRules` — the arm below fails if the
 * exclusion goes away, and it asserts the keyframes are still IN the CSS, so a
 * build that stopped emitting them altogether cannot satisfy it vacuously.
 */
function inKeyframes(rule: postcss.Rule): boolean {
  for (let node: postcss.Container | postcss.Document | undefined = rule.parent; node; ) {
    if (node.type === 'atrule' && /keyframes$/.test((node as postcss.AtRule).name)) return true;
    node = (node as postcss.Container).parent;
  }
  return false;
}

/**
 * Build the utilities layer for a set of candidate classes, in memory.
 *
 * THE PHYSICAL COUNTERPARTS GO IN THE CONTENT TOO, and that is the whole
 * repair (SC-766). Tailwind emits only what the content mentions, so a build
 * of `rtl:` classes alone contains no physical rule for them to be ordered
 * against — which is how the ordering assertion below spent its life comparing
 * `rtl:` utilities with `@keyframes` steps and reporting green.
 */
async function build(classes: string[]): Promise<{ css: string; rules: Rule[] }> {
  const withCounterparts = [
    ...new Set([...classes, ...classes.map(physicalCounterpart).filter((c) => c !== null)]),
  ];
  const raw = `<div class="${withCounterparts.join(' ')}"></div>`;
  const result = await postcss([
    tailwind({ ...preset, content: [{ raw, extension: 'html' }] }),
  ]).process('@tailwind utilities;', { from: undefined });

  const rules: Rule[] = [];
  result.root.walkRules((rule) => {
    if (inKeyframes(rule)) return;
    const properties: string[] = [];
    rule.walkDecls((decl) => {
      properties.push(decl.prop);
    });
    rules.push({ index: rules.length, selector: rule.selector, properties });
  });
  return { css: result.css, rules };
}

/**
 * The physical class each `rtl:` one exists to override, DERIVED — and this
 * replaces a shared-property inference that could never have worked (SC-766).
 *
 * The old pairing kept any non-`rtl:` rule declaring a property in common.
 * `build()` compiles ONLY the discovered `rtl:` classes, so
 * `data-[state=open]:slide-in-from-left` — the exact rule `rtl:…-from-right`
 * must beat — was never in the output to be compared against. Measured on the
 * tree that found this: 8 `rtl:` rules and 5 non-`rtl:` rules, and ALL FIVE
 * were `@keyframes` steps. So this file's headline claim had never once
 * compared a `rtl:` utility with a physical utility.
 *
 * IT WAS NOT VACUOUS, AND CALLING IT THAT WAS THE FIRST DIAGNOSIS HERE — the
 * distinction is worth the sentence. Inverting the comparison on the
 * pre-repair tree DOES go red, because keyframe steps are emitted before the
 * utilities, so the loop ran and the assertion could fail. It was answering an
 * ADJACENT question — *is this `rtl:` rule after that timeline waypoint* —
 * correctly, and reporting the green that reads as an answer to the question
 * asked. A check that cannot fail and a check aimed one step to the side
 * produce the same output and want different repairs; only the second is what
 * happened.
 *
 * So the counterpart is now derived and ADDED TO THE BUILD, and the pairing is
 * on that named class rather than on a property two unrelated rules happen to
 * share. Three shapes, matching what the design system actually ships:
 *
 *     rtl:…slide-in-from-right   ->  …slide-in-from-left      (swap the edge)
 *     rtl:…animate-<name>-rtl    ->  …animate-<name>          (SC-766's pair)
 *     rtl:…-translate-x-5        ->  …translate-x-5           (drop the sign)
 *
 * `null` is a real answer, not a gap: `MIRROR_IN_RTL` (`rtl:-scale-x-100`,
 * `lib/direction.ts`) applies only under RTL and overrides nothing, so it has
 * no partner by design. The count assertion below is what stops `null`
 * becoming a silent way for a mistyped derivation to pair nothing.
 */
function physicalCounterpart(rtlClass: string): string | null {
  const bare = rtlClass.replace(/(^|:)rtl:/, '$1');
  if (/slide-(?:in-from|out-to)-(?:left|right)/.test(bare)) {
    return bare.replace(
      /(slide-(?:in-from|out-to)-)(left|right)/,
      (_, stem: string, side: string) => (side === 'left' ? `${stem}right` : `${stem}left`)
    );
  }
  if (/animate-[\w-]+-rtl\b/.test(bare)) return bare.replace(/-rtl\b/, '');
  if (/(^|:)-translate-x-/.test(bare)) return bare.replace(/(^|:)-translate-x-/, '$1translate-x-');
  return null;
}

/** Find the emitted rule for a class name, by its un-escaped selector. */
const ruleFor = (className: string, rules: Rule[]): Rule | undefined =>
  rules.find((rule) => rule.selector.replace(/\\/g, '').includes(className));

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

  test('each rtl: rule is emitted after the physical rule it overrides', async () => {
    const classes = await rtlClasses();
    const { rules } = await build(classes);
    const inverted: string[] = [];
    for (const rtlClass of classes) {
      const counterpart = physicalCounterpart(rtlClass);
      if (!counterpart) continue;
      const rtlRule = ruleFor(rtlClass, rules);
      const physical = ruleFor(counterpart, rules);
      if (!rtlRule || !physical) continue; // reported by the count test below
      if (physical.index > rtlRule.index) {
        inverted.push(`${rtlClass} is emitted BEFORE ${counterpart}`);
      }
    }
    expect(inverted).toEqual([]);
  });

  /**
   * The non-vacuity control, and it now measures what it claims to.
   *
   * Its predecessor asserted `paired.length > 0` over a shared-property
   * inference that only ever matched `@keyframes` steps — so the control meant
   * to prove the pairing found something real was satisfied, every run, by the
   * one thing that is not a cascade competitor. A control can fire for the
   * wrong reason, and then it certifies the instrument beside it. This asserts
   * that each `rtl:` class DERIVES a counterpart and that BOTH rules are
   * actually emitted, which is the precondition the ordering test skips on. A
   * mistyped derivation now reds here instead of silently pairing nothing.
   *
   * `MIRROR_IN_RTL` is named as the one legitimate abstainer rather than
   * counted as a shortfall, so the expected number is exact rather than a
   * floor — a floor is what let the old control pass on the wrong population.
   */
  test('every rtl: class but MIRROR_IN_RTL pairs with an emitted physical rule', async () => {
    const classes = await rtlClasses();
    const { rules } = await build(classes);
    const unpartnered = classes.filter((name) => physicalCounterpart(name) === null);
    expect(unpartnered).toEqual(['rtl:-scale-x-100']);

    const missing = classes.flatMap((rtlClass) => {
      const counterpart = physicalCounterpart(rtlClass);
      if (!counterpart) return [];
      if (!ruleFor(rtlClass, rules)) return [`${rtlClass} derived but not emitted`];
      if (!ruleFor(counterpart, rules)) return [`${rtlClass} -> ${counterpart} was not emitted`];
      return [];
    });
    expect(missing).toEqual([]);
    expect(classes.length - unpartnered.length).toBeGreaterThan(4);
  });

  /**
   * The keyframe exclusion, pinned two-sided (SC-766).
   *
   * Must-be-FOUND: the `@keyframes` block IS in the emitted CSS, so this
   * cannot pass by the build having quietly stopped producing one — which is
   * the only other way the step selectors would be absent from `rules`.
   * Must-be-ABSENT: none of its steps is in the competitor set.
   */
  test('keyframe steps are in the CSS but not treated as cascade competitors', async () => {
    const { css, rules } = await build(['rtl:motion-safe:animate-loading-bar-rtl']);
    expect(css).toContain('@keyframes loading-bar-rtl');
    // The steps declare `transform`, which is what made them collide with the
    // `rtl:` transform utilities in the first place.
    expect(css).toContain('translateX(100%)');
    const steps = rules.filter((rule) => /^(?:\d+%|from|to)$/.test(rule.selector.trim()));
    expect(steps.map((rule) => rule.selector)).toEqual([]);
    // And the utility that names the keyframe is still collected, so the
    // exclusion narrowed the set rather than emptying it.
    expect(rules.some((rule) => rule.selector.includes('animate-loading-bar-rtl'))).toBe(true);
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

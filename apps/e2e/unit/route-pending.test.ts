import { describe, expect, test } from 'bun:test';
import { classifySpinner, describeSpinner, type SpinnerEvidence } from '../visual/route-pending';

/**
 * That the gate can tell its two spinners apart (SC-840).
 *
 * ## Why this test is about a SENTENCE
 *
 * `playwright.visual.config.ts` sets `trace: 'off'`, `video: 'off'` and
 * `screenshot: 'off'`, so when a screen comes back holding a spinner the only
 * thing that survives the run is the message. Four SC-825 runs hit cause B on
 * four different screens and produced four dead ends, because the message they
 * produced named cause A — `assertPhotographedOnce`'s route-pending branch is
 * reachable only when `loads.count <= 1`, and it cited SC-499, whose mechanism
 * is a document load. It fired precisely when its own stated cause was
 * excluded.
 *
 * So the property under test is not "the guard fires". It is **that the verdict
 * is a function of the evidence** — the same shape as the SC-190 family, where
 * an exit code could not tell "everything passed" from "nothing ran".
 *
 * ## The arms
 *
 * A test asserting only that a spinner produces *a* message would pass against
 * the defect: the old code produced a message too, and it was wrong. Both
 * causes are therefore driven through the SAME function with the SAME shape of
 * evidence, differing only in the load count — the one datum that separates
 * them — and each arm asserts what the OTHER arm's message must not contain.
 */

function evidence(over: Partial<SpinnerEvidence> = {}): SpinnerEvidence {
  return {
    screen: 'home-desktop',
    loads: { count: 1, at: [412] },
    pending: [{ chunk: 'interface', phase: 'loading', failures: 0 }],
    shellPresent: true,
    where: 'when the capture finished',
    ...over,
  };
}

describe('classifySpinner', () => {
  test('a second document load is cause A, whatever the DOM holds', () => {
    // Both pending and not: the load count decides on its own, because a
    // reload lands the page back behind the fallback and would otherwise be
    // read as B by whichever check looked at the DOM first.
    expect(classifySpinner(evidence({ loads: { count: 2, at: [412, 5100] } }))).toBe('reload');
    expect(classifySpinner(evidence({ loads: { count: 2, at: [412, 5100] }, pending: [] }))).toBe(
      'reload'
    );
  });

  test('a pending chunk with no extra load is cause B', () => {
    expect(classifySpinner(evidence())).toBe('route-pending');
  });

  test('nothing pending and no reload is neither, and says so rather than picking one', () => {
    expect(classifySpinner(evidence({ pending: [], shellPresent: false }))).toBe('shell-gone');
  });
});

describe('describeSpinner', () => {
  test('cause A names the reload and the module-graph write', () => {
    const message = describeSpinner(evidence({ loads: { count: 3, at: [412, 5100, 9004] } }));
    expect(message).toContain('RELOAD (cause A, SC-499)');
    expect(message).toContain('412ms, 5100ms, 9004ms');
    expect(message).toContain('module');
    // The B verdict must not appear on an A capture — one message, one cause.
    expect(message).not.toContain('cause B');
  });

  test('cause B does NOT cite SC-499, and prints the count that rules it out', () => {
    // This is the regression. The shipped message said "The SPA remounted
    // mid-capture (SC-499)" from a branch that only runs when no reload
    // happened, and every reader who followed the citation went looking for a
    // module-graph write that was not there.
    const message = describeSpinner(evidence());
    expect(message).toContain('ROUTE-PENDING (cause B, SC-840)');
    expect(message).toContain('THIS IS NOT THE SC-499 RELOAD');
    // Not merely the absence of the claim — the count that excludes it.
    expect(message).toContain('1 document load(s)');
    expect(message).not.toContain('cause A');
    expect(message).not.toContain('do not lint, rebase');
  });

  test('cause B names WHICH chunk, which the shipped spec discarded', () => {
    // `data-route-pending`'s value has always been the chunk name and the spec
    // read it with `.count()`. `lazy()` memoises, so a fallback appearing after
    // one detached is either a different chunk or the same one re-suspending —
    // and the name is what separates those.
    const message = describeSpinner(
      evidence({ pending: [{ chunk: 'component gallery', phase: 'loading', failures: 0 }] })
    );
    expect(message).toContain('component gallery');
  });

  test('a chunk that had already FAILED reads differently from one still arriving', () => {
    // The family this ticket is an instance of: for the whole of importChunk's
    // 250ms/500ms backoff the DOM is identical whether the first request is in
    // flight or two have already rejected. If these two produce the same
    // sentence, the gate has not distinguished them — it has only renamed the
    // one it already had.
    const arriving = describeSpinner(evidence());
    const failing = describeSpinner(
      evidence({ pending: [{ chunk: 'interface', phase: 'retrying', failures: 2 }] })
    );

    expect(arriving).toContain('first request, nothing had failed yet');
    expect(failing).toContain('ALREADY FAILED');
    expect(failing).toContain('waiting longer would not have helped');
    expect(arriving).not.toBe(failing);
  });

  test('a build with no phase attribute says so rather than guessing one', () => {
    // `?? 'loading'` would have been the tidy default and it would print a
    // guess in the same slot as a measurement. An older build is a real case:
    // the gate can be pointed at a frontend container that predates SC-840.
    const message = describeSpinner(
      evidence({ pending: [{ chunk: 'interface', phase: 'unknown', failures: -1 }] })
    );
    expect(message).toContain('unrecorded');
    expect(message).not.toContain('first request, nothing had failed yet');
  });
});

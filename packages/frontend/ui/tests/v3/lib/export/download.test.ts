import { afterEach, describe, expect, it } from 'bun:test';
import {
  describeDownload,
  downloadFile,
  isShareDismissal,
  shareNeverStarted,
} from '../../../../src/v3/lib/export/download';

/**
 * SC-93 item 1, candidate 2 — the half that is our own code and can therefore
 * be pinned without a device.
 *
 * The reported defect (two files from one press on the installed iOS PWA) has
 * two plausible causes. Candidate 1 is iOS writing the share payload's `title`
 * as its own document, which nothing on this side can observe. Candidate 2 is
 * this: `downloadFile` fell through to the anchor for *any* non-`AbortError`,
 * so a share that had already handed the file to iOS and then rejected produced
 * a shared file **and** an anchor download.
 *
 * These tests are about the second one. They do not prove what happened on
 * mgrin's phone; they prove this function can no longer be the cause.
 */

interface Recorded {
  share: unknown[];
  anchorClicks: number;
}

function install(
  shareImpl: (data: unknown) => Promise<void>,
  { standalone = true, canShare = true } = {}
): Recorded {
  const recorded: Recorded = { share: [], anchorClicks: 0 };

  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  nav.standalone = standalone;
  nav.canShare = () => canShare;
  nav.share = (data: unknown) => {
    recorded.share.push(data);
    return shareImpl(data);
  };

  // `bun test` has no DOM, and the anchor path touches only four things:
  // create an <a>, set three properties, click it, remove it. Stubbing exactly
  // those keeps the test about the branch under test rather than about jsdom.
  const glob = globalThis as unknown as Record<string, unknown>;
  glob.document = {
    createElement: (tag: string) =>
      tag === 'a'
        ? {
            style: {},
            click: () => {
              recorded.anchorClicks += 1;
            },
            remove: () => {},
          }
        : { style: {} },
    body: { appendChild: () => {} },
  };
  // The two statics are added to the REAL `URL`, not swapped for an object
  // that happens to carry them. Replacing the global outright is what the first
  // version did, and `{ ...URL }` is not a constructor — so every other suite
  // in the same `bun test` process lost `new URL(...)`. It only showed up when
  // the file was run alongside others, which is the whole reason to restore
  // globals rather than reassign them.
  urlStatics.createObjectURL = URL.createObjectURL;
  urlStatics.revokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = () => 'blob:stub';
  URL.revokeObjectURL = () => {};

  return recorded;
}

const urlStatics: Partial<Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>> = {};

afterEach(() => {
  const nav = globalThis.navigator as unknown as Record<string, unknown>;
  nav.standalone = undefined;
  nav.share = undefined;
  nav.canShare = undefined;
  const glob = globalThis as unknown as Record<string, unknown>;
  glob.document = undefined;
  if (urlStatics.createObjectURL) URL.createObjectURL = urlStatics.createObjectURL;
  if (urlStatics.revokeObjectURL) URL.revokeObjectURL = urlStatics.revokeObjectURL;
});

const blob = () => new Blob(['a,b\r\n1,2\r\n'], { type: 'text/csv' });

describe('downloadFile on the share path', () => {
  it('never also writes an anchor download when the share may hold the file', async () => {
    // The regression. `InvalidAccessError` is not `AbortError` and is not one of
    // the never-started errors, so the old code fell straight through to the
    // anchor — one press, two files.
    const failAfterHandoff = () => Promise.reject(new DOMException('boom', 'InvalidAccessError'));
    const recorded = install(failAfterHandoff);

    await expect(downloadFile(blob(), 'scani-holdings.csv')).rejects.toThrow();
    expect(recorded.share).toHaveLength(1);
    expect(recorded.anchorClicks).toBe(0);
  });

  it('does fall through when the share provably never started', async () => {
    const recorded = install(() =>
      Promise.reject(new DOMException('no activation', 'NotAllowedError'))
    );
    const result = await downloadFile(blob(), 'scani-holdings.csv');
    expect(result).toEqual({ strategy: 'anchor', completed: true });
    expect(recorded.anchorClicks).toBe(1);
  });

  it('reports a dismissed sheet as nothing saved, and writes nothing', async () => {
    const recorded = install(() => Promise.reject(new DOMException('user', 'AbortError')));
    const result = await downloadFile(blob(), 'scani-holdings.csv');
    expect(result).toEqual({ strategy: 'share', completed: false });
    expect(recorded.anchorClicks).toBe(0);
  });

  it('shares the file and nothing else — no title, no text, no url', async () => {
    // SC-93 item 1, candidate 1. Removing `title` costs nothing (the `File`
    // already carries its name) and closes a plausible cause of the stray
    // one-line file. This test is what stops it — or a `text`/`url` added for
    // SC-94's PDF — from coming back.
    const recorded = install(() => Promise.resolve());
    const result = await downloadFile(blob(), 'scani-holdings.csv');

    expect(result).toEqual({ strategy: 'share', completed: true });
    const payload = recorded.share[0] as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(['files']);
  });
});

describe('shareNeverStarted', () => {
  it('recognises the rejections raised before a share target exists', () => {
    for (const name of ['NotAllowedError', 'NotSupportedError', 'DataError', 'InvalidStateError']) {
      expect(shareNeverStarted(new DOMException('x', name))).toBe(true);
    }
    expect(shareNeverStarted(new TypeError('not shareable'))).toBe(true);
  });

  it('treats anything unrecognised as possibly-handed-off', () => {
    // The safe direction: one file the reader can ask for again beats two they
    // have to tell apart.
    expect(shareNeverStarted(new DOMException('x', 'AbortError'))).toBe(false);
    expect(shareNeverStarted(new DOMException('x', 'SomethingNewInIOS27'))).toBe(false);
    expect(shareNeverStarted(new Error('plain'))).toBe(false);
  });

  it('is distinct from a dismissal', () => {
    expect(isShareDismissal(new DOMException('x', 'AbortError'))).toBe(true);
    expect(isShareDismissal(new DOMException('x', 'NotAllowedError'))).toBe(false);
  });
});

describe('describeDownload', () => {
  it('claims a download only on the anchor path', () => {
    const said = describeDownload({ strategy: 'anchor', completed: true }, 'f.csv', '19 holdings');
    expect(said.title).toBe('Exported');
    expect(said.message).toBe('19 holdings in f.csv');
  });

  it('stops at what the share API can actually tell us', () => {
    // `navigator.share` resolving means iOS accepted the handoff, not that a
    // file landed anywhere. The wording has to stop there.
    const said = describeDownload({ strategy: 'share', completed: true }, 'f.csv', '19 holdings');
    expect(said.title).toBe('Sent to your share sheet');
    expect(said.message).toContain('Save to Files');
    expect(said.title).not.toContain('Exported');
  });
});

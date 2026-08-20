import { uiT } from '../../../i18n';
/**
 * Getting the file off the page and onto the reader's device.
 *
 * On a desktop browser this is four lines and has been for fifteen years: an
 * `<a download>` pointed at a blob URL. The reason this module is longer is the
 * installed iOS PWA, where those four lines can do **nothing at all** — no
 * file, no error, no sign that a button was pressed. That silence is the
 * failure mode SC-89 called out, and it is worse than an absent feature,
 * because the reader concludes their data is stuck.
 *
 * Standalone WebKit treats a blob-URL navigation as a navigation *of the app*.
 * Depending on the iOS version it either replaces the running PWA with a
 * download view the user then has to navigate back out of, or — where the
 * anchor is clicked outside the synchronous tail of a user gesture, which
 * building a workbook guarantees — is dropped on the floor.
 *
 * The path that does work there is the share sheet: `navigator.share` with a
 * `File`, which offers **Save to Files** among its targets. It is a real iOS
 * affordance rather than a workaround, it keeps the PWA on screen, and it is
 * the same gesture the reader uses to send the file to Mail or Numbers, which
 * is usually what they wanted anyway.
 *
 * So: share sheet where the anchor is unreliable, anchor everywhere else. The
 * choice is a pure function so it can be tested without a browser, and
 * `downloadFile` reports which path it took so the caller can word its
 * confirmation honestly — "Saved" and "Shared" are not the same claim.
 */

export type DownloadStrategy = 'share' | 'anchor';

interface DownloadEnvironment {
  /** iOS Safari's own flag for "running as an installed app". Absent
   *  everywhere else, including desktop Safari and every Chromium. */
  standalone: boolean;
  /** Whether `navigator.canShare({ files })` accepted this file. */
  canShareFiles: boolean;
}

/**
 * Anchor download unless we are inside an installed iOS app *and* the share
 * sheet will take the file.
 *
 * Deliberately narrow. An installed PWA on Android downloads through the anchor
 * perfectly well and its share sheet has no file-system target worth the extra
 * tap, so the condition is the standalone flag — which only iOS sets — rather
 * than `display-mode: standalone`, which Android sets too.
 */
export function resolveDownloadStrategy(env: DownloadEnvironment): DownloadStrategy {
  return env.standalone && env.canShareFiles ? 'share' : 'anchor';
}

function readEnvironment(file: File): DownloadEnvironment {
  const nav = navigator as Navigator & { standalone?: boolean };
  let canShareFiles = false;
  try {
    canShareFiles = typeof nav.share === 'function' && Boolean(nav.canShare?.({ files: [file] }));
  } catch {
    canShareFiles = false;
  }
  return { standalone: nav.standalone === true, canShareFiles };
}

export interface DownloadResult {
  strategy: DownloadStrategy;
  /**
   * What we actually know happened — and on the share path that is less than it
   * sounds.
   *
   * `true` from the **anchor** means the browser was handed a download. `true`
   * from the **share sheet** means only that iOS *accepted the handoff*: the
   * Web Share API resolves when the payload reaches the share target and tells
   * us nothing about whether a file landed where the reader wanted it. The
   * caller's wording has to stop at that ceiling. A toast that says "Exported"
   * when all we know is "sent to the share sheet" is how someone concludes
   * their data is safe when it is not.
   *
   * `false` means the reader dismissed the sheet: nothing went wrong and
   * nothing was saved, so nothing should be announced.
   */
  completed: boolean;
}

/**
 * Whether a `navigator.share` rejection means the share **never started**.
 *
 * This is the whole of SC-93 item 1's second candidate, and it is an allowlist
 * rather than a denylist on purpose. The old code fell through to the anchor
 * for *any* non-`AbortError`, which is only safe if every such error is thrown
 * before iOS takes the payload — and it is not. Once the sheet is on screen the
 * only rejection the spec defines is `AbortError`, so anything unrecognised
 * arriving after that point would have produced a shared file *and* an anchor
 * download: two files, from one press.
 *
 * The errors below are all raised synchronously by the API's own checks, before
 * any share target exists:
 *
 * - `NotAllowedError` — no transient activation, or permission refused.
 * - `TypeError` — the payload is not shareable at all.
 * - `NotSupportedError` / `DataError` — this file cannot be shared here.
 * - `InvalidStateError` — a share is already in flight.
 *
 * Anything else is treated as "iOS may already have it", and the anchor is not
 * fired. The failure mode that leaves is one missing file the reader can ask
 * for again — strictly better than two files they have to tell apart and clean
 * up, one of which they did not ask for.
 */
const SHARE_NEVER_STARTED = new Set([
  'NotAllowedError',
  'NotSupportedError',
  'DataError',
  'InvalidStateError',
]);

export function shareNeverStarted(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  return error instanceof DOMException && SHARE_NEVER_STARTED.has(error.name);
}

export function isShareDismissal(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export async function downloadFile(blob: Blob, fileName: string): Promise<DownloadResult> {
  const file = new File([blob], fileName, { type: blob.type });
  const strategy = resolveDownloadStrategy(readEnvironment(file));

  if (strategy === 'share') {
    try {
      // `files` and nothing else — no `title`, no `text`, no `url`, now or
      // ever. iOS hands any text member to the share target *alongside* the
      // file, and Save to Files can write it out as a second document; the
      // `File` already carries its own name, so every text member here is
      // both redundant and a way to turn one export into two. Enforced by a
      // test rather than by this comment.
      await navigator.share({ files: [file] });
      return { strategy, completed: true };
    } catch (error) {
      if (isShareDismissal(error)) return { strategy, completed: false };
      // The share may already hold the payload — writing a second copy through
      // the anchor is never the right answer to an ambiguous failure. Hand the
      // error to the caller, which already reports it, and write nothing.
      if (!shareNeverStarted(error)) throw error;
      // Otherwise the share never happened, and the anchor is the real attempt.
    }
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  // In the document, because Firefox ignores `click()` on a detached anchor.
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Not immediately: Safari reads the blob asynchronously after the click, and
  // revoking in the same tick cancels the download it just started.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);

  return { strategy: 'anchor', completed: true };
}

/**
 * `scani-holdings-filtered-2026-08-14.csv`.
 *
 * The file name is the export's only provenance in a CSV — the format has no
 * room for a note and gets none (see `workbook.ts`) — so it carries the three
 * facts a folder of these needs to be told apart: what, which subset, and when.
 * Lowercase and hyphenated because it is a file name that will be typed into a
 * terminal and pasted into a chat.
 */
export function exportFileName(
  subject: string,
  extension: 'csv' | 'xlsx' | 'pdf',
  options: { filtered?: boolean; date?: Date } = {}
): string {
  const slug = subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const date = (options.date ?? new Date()).toISOString().slice(0, 10);
  const scope = options.filtered ? '-filtered' : '';
  return `scani-${slug || 'export'}${scope}-${date}.${extension}`;
}

/**
 * What to tell the reader, worded to what we actually know.
 *
 * Central because three surfaces announce a download and a fourth is coming
 * with SC-94, and the honest wording is the kind of detail that drifts the
 * moment it is retyped. The anchor path can say the file was exported; the
 * share path can only say it was handed to iOS, so it says that and names the
 * next tap instead of claiming an outcome it cannot observe.
 */
export function describeDownload(
  result: DownloadResult,
  fileName: string,
  subject: string
): { title: string; message: string } {
  // Resolved against the KIT's instance, never a caller's (SC-316) — see the
  // note on `toExportBlob`. The subject stays the caller's: it is the noun for
  // the thing that left, and this module cannot know it.
  const t = uiT;
  if (result.strategy === 'share') {
    return {
      title: t('ui.export.download.shared'),
      message: t('ui.export.download.sharedDetail', { fileName }),
    };
  }
  return {
    title: t('ui.export.download.saved'),
    message: t('ui.export.download.savedDetail', { subject, fileName }),
  };
}

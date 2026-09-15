import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { CaptureHeader } from '../../../src/v3/components/capture/CaptureHeader';
import en from '../../../src/v3/i18n/locales/en.json';
import { readV3Source } from '../helpers/v3-sources';

/**
 * The demo says what a write does, at every point where a write is offered
 * (SC-1207).
 *
 * A text scan rather than a render, and the reason is the component's own
 * shape: `DemoCaptureNote` reads `isDemo` from `AuthContext`, which has no
 * exported context and no test provider, so `renderToStaticMarkup` of it
 * throws outside a real `AuthProvider` — and `mock.module` is global in bun,
 * so mocking `@/contexts/AuthContext` for one file would leak the mock into
 * every other test in the process. The same reasoning as `layout.test.ts` and
 * `token-hygiene.test.ts`: each failure below type-checks, lints and renders,
 * and is only *wrong*, on a deployment nobody develops against.
 *
 * Every test here carries its own control, because a scan for an absence is
 * indistinguishable from a scan that read the wrong file.
 */

const NOTE = 'components/capture/DemoCaptureNote.tsx';
const KEY = 'v3.capture.demoNote';
const LOCALES = join(import.meta.dir, '../../../src/v3/i18n/locales');

/** Every `<DemoCaptureNote />` mount in a file, comments included — a mount
 *  inside a comment is not a mount, but neither call site has one, and
 *  counting the JSX element is what the "identical in both places" claim is
 *  about. */
function mounts(source: string): number {
  return source.split(/<DemoCaptureNote\s*\/>/).length - 1;
}

describe('the demo capture note', () => {
  test('renders nothing outside the demo, and does not throw for asking', () => {
    // The one render assertion here, and it is the arm that matters off the
    // demo: `app.scani.xyz` is every paying reader, and a note claiming their
    // entries are discarded would be worse than no note at all. No
    // `AuthProvider` above this, deliberately — `useIsDemo` answers `false`
    // where `useAuth` would throw, which is what lets `CaptureHeader` be
    // rendered by a test at all.
    const markup = renderToStaticMarkup(
      <StaticRouter location="/">
        <CaptureHeader title="Type it in" description="One holding at a time." />
      </StaticRouter>
    );
    expect(markup).not.toContain('demo-capture-note');
    expect(markup).not.toContain(en.v3.capture.demoNote);
    // Control: the header itself rendered, so the absences above are readings
    // rather than an empty string.
    expect(markup).toContain('Type it in');
  });

  test('is withheld by a check on the demo flag, not by an empty body', async () => {
    const source = await readV3Source(NOTE);
    expect(source).toContain('if (!isDemo) return null;');
    // Control: the early return is only meaningful if there is a body to
    // withhold. A file that lost its render would pass the line above.
    expect(source).toContain(KEY);
  });

  test('names the outcome rather than calling the deployment read-only', () => {
    // Operator ruling, 2026-09-15. This note sits three lines from API-key
    // permissions on the integration screens, where "read-only" is a property
    // of the KEY the reader is about to paste. The most precise word for the
    // deployment is the one most likely to be read as being about something
    // else, so the sentence says what happens to the entry instead.
    expect(en.v3.capture.demoNote.toLowerCase()).not.toContain('read-only');
    // Control: the shell's banner is where "read-only" still belongs — nothing
    // above is a repo-wide ban, and a reading of zero there would mean this
    // test is looking at the wrong file.
    expect(en.v3.shell.demo.banner.toLowerCase()).toContain('read-only');
  });

  test('says it in one key, not in a literal anybody can respell', async () => {
    const source = await readV3Source(NOTE);
    expect(source).not.toContain(en.v3.capture.demoNote);
    // Control: that sentence exists, so the assertion above is about a string
    // the component could plausibly have inlined.
    expect(en.v3.capture.demoNote.length).toBeGreaterThan(20);
  });

  test('is mounted on every capture screen and on both shells of the sheet', async () => {
    // `CaptureHeader` is every capture page's top, so one mount covers all
    // seven; `CaptureSheet` renders a desktop panel and a mobile drawer from
    // separate branches, so it needs one each and a single mount would leave
    // the phone — where the demo is most often met from a link — unsigned.
    expect(mounts(await readV3Source('components/capture/CaptureHeader.tsx'))).toBe(1);
    expect(mounts(await readV3Source('components/capture/CaptureSheet.tsx'))).toBe(2);
    // Control: the counter reports zero on a v3 file that does not mount it.
    expect(mounts(await readV3Source('components/DemoBanner.tsx'))).toBe(0);
  });

  test('is translated everywhere, not left in English on a Russian demo', async () => {
    const files = readdirSync(LOCALES).filter((name) => name.endsWith('.json'));
    // Control: the sweep found the locales at all.
    expect(files.length).toBeGreaterThan(1);

    for (const file of files) {
      const locale = file.replace(/\.json$/, '');
      const strings = (await Bun.file(join(LOCALES, file)).json()) as {
        v3?: { capture?: { demoNote?: string } };
      };
      const value = strings.v3?.capture?.demoNote;
      expect(value, `${locale} has no ${KEY}`).toBeString();
      if (locale === 'en') continue;
      expect(value, `${locale} still carries the English sentence`).not.toBe(
        en.v3.capture.demoNote
      );
    }
  });
});

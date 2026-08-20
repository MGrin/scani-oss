import { describe, expect, test } from 'bun:test';
import i18n from 'i18next';
import { serverUnreachableCopy } from '@/lib/offline-shell';

/**
 * SC-78 §2. Offline, an installed-PWA cold start landed on "Welcome / Enter
 * your email" — a claim that the reader had been logged out, which was false:
 * relaunching with the api back went straight to the holdings screen, session
 * intact. The reader had no way to know that, and the obvious response to being
 * told you are logged out is to sign in, which walked into §1's wedge.
 *
 * So the one thing this screen must never do is imply a sign-out.
 *
 * **The English assertions are unchanged from before the keys existed**
 * (SC-410), which is the point: `t` comes from the same `en.json` the app
 * ships, so a key pointed at the wrong string fails here rather than shipping.
 * The Russian block below is not a translation review — it checks the two
 * properties the copy is *for*, in the language a reader who cannot reach the
 * server is most likely to be reading it in.
 */

const t = i18n.getFixedT('en');
const ru = i18n.getFixedT('ru');

describe('what the app says when it cannot reach its server', () => {
  test('says the server is unreachable, never that anyone is signed out', () => {
    const copy = serverUnreachableCopy({ email: 'steve@scani.xyz', online: true, t });
    expect(copy.title).toBe('Can’t reach Scani');
    expect(Object.values(copy).join(' ')).not.toMatch(/you have been (signed|logged) out/i);
    expect(copy.title).not.toMatch(/welcome/i);
  });

  test('keeps the session in words, and names who', () => {
    const copy = serverUnreachableCopy({ email: 'steve@scani.xyz', online: false, t });
    expect(copy.body).toInclude('still signed in as steve@scani.xyz');
    expect(copy.body).toInclude('Nothing has been logged out');
  });

  test('claims no session when this device has never seen one', () => {
    const copy = serverUnreachableCopy({ email: null, online: true, t });
    expect(copy.body).not.toInclude('still signed in');
  });

  test('names which half is broken, since the two need different patience', () => {
    expect(serverUnreachableCopy({ email: null, online: false, t }).subtitle).toInclude(
      'no connection'
    );
    expect(serverUnreachableCopy({ email: null, online: true, t }).subtitle).toInclude(
      'didn’t answer'
    );
  });

  test('promises the recovery standalone cannot get from a reload button', () => {
    const copy = serverUnreachableCopy({ email: null, online: false, t });
    expect(copy.reassurance).toInclude('retries on its own');
    expect(copy.retryLabel).toBe('Try again');
  });
});

describe('and says it in the reader’s language', () => {
  test('every string is translated, not a fallback to English', () => {
    const copy = serverUnreachableCopy({ email: 'steve@scani.xyz', online: true, t: ru });
    const english = serverUnreachableCopy({ email: 'steve@scani.xyz', online: true, t });
    for (const [field, value] of Object.entries(copy)) {
      expect(value).not.toBe(english[field as keyof typeof english]);
      // A raw key is the other way this fails, and it looks like copy in a
      // language you do not read.
      expect(value).not.toStartWith('offline.');
    }
  });

  test('still names who, and still refuses to imply a sign-out', () => {
    const copy = serverUnreachableCopy({ email: 'steve@scani.xyz', online: false, t: ru });
    expect(copy.body).toInclude('steve@scani.xyz');
    expect(copy.body).toInclude('не выводили');
    expect(copy.title).not.toMatch(/Добро пожаловать/);
  });

  test('names which half is broken there too', () => {
    expect(serverUnreachableCopy({ email: null, online: false, t: ru }).subtitle).toInclude(
      'нет связи'
    );
    expect(serverUnreachableCopy({ email: null, online: true, t: ru }).subtitle).toInclude(
      'не ответил'
    );
  });
});

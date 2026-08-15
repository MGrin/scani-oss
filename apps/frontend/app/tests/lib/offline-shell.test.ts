import { describe, expect, test } from 'bun:test';
import { serverUnreachableCopy } from '@/lib/offline-shell';

/**
 * SC-78 §2. Offline, an installed-PWA cold start landed on "Welcome / Enter
 * your email" — a claim that the reader had been logged out, which was false:
 * relaunching with the api back went straight to the holdings screen, session
 * intact. The reader had no way to know that, and the obvious response to being
 * told you are logged out is to sign in, which walked into §1's wedge.
 *
 * So the one thing this screen must never do is imply a sign-out.
 */

describe('what the app says when it cannot reach its server', () => {
  test('says the server is unreachable, never that anyone is signed out', () => {
    const copy = serverUnreachableCopy({ email: 'steve@scani.xyz', online: true });
    expect(copy.title).toBe('Can’t reach Scani');
    expect(Object.values(copy).join(' ')).not.toMatch(/you have been (signed|logged) out/i);
    expect(copy.title).not.toMatch(/welcome/i);
  });

  test('keeps the session in words, and names who', () => {
    const copy = serverUnreachableCopy({ email: 'steve@scani.xyz', online: false });
    expect(copy.body).toInclude('still signed in as steve@scani.xyz');
    expect(copy.body).toInclude('Nothing has been logged out');
  });

  test('claims no session when this device has never seen one', () => {
    const copy = serverUnreachableCopy({ email: null, online: true });
    expect(copy.body).not.toInclude('still signed in');
  });

  test('names which half is broken, since the two need different patience', () => {
    expect(serverUnreachableCopy({ email: null, online: false }).subtitle).toInclude(
      'no connection'
    );
    expect(serverUnreachableCopy({ email: null, online: true }).subtitle).toInclude(
      'didn’t answer'
    );
  });

  test('promises the recovery standalone cannot get from a reload button', () => {
    const copy = serverUnreachableCopy({ email: null, online: false });
    expect(copy.reassurance).toInclude('retries on its own');
    expect(copy.retryLabel).toBe('Try again');
  });
});

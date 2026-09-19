import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountDeletionNoticeView } from '../../../src/v3/components/settings/AccountDeletionNotice';

/**
 * SC-1276. The browser signs out the moment an account deletion is queued, so
 * a job that then fails leaves an account its owner believes is gone. The next
 * sign-in is the only chance to say so. `null` renders nothing: a notice that
 * always showed would pass every other case here.
 */

const html = (deletion: Parameters<typeof AccountDeletionNoticeView>[0]['deletion']) =>
  renderToStaticMarkup(
    <AccountDeletionNoticeView deletion={deletion} onRetry={() => {}} retrying={false} />
  );

describe('the account deletion notice', () => {
  test('says nothing when no deletion is outstanding', () => {
    expect(html(null)).toBe('');
  });

  test('a failure says the account is still here, with a way to try again', () => {
    const markup = html({ jobId: 'd', failed: true, message: null });
    expect(markup).toContain('did not complete');
    expect(markup).toContain('Try again');
  });

  test('a failure shows the words written for its owner when there are some', () => {
    expect(html({ jobId: 'd', failed: true, message: 'Contact support.' })).toContain(
      'Contact support.'
    );
  });

  test('one still running says so, and offers no retry', () => {
    const markup = html({ jobId: 'd', failed: false, message: null });
    expect(markup).toContain('being deleted');
    expect(markup).not.toContain('Try again');
  });
});

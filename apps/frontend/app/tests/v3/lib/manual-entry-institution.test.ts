import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { emptyAccountTarget, withInstitution } from '../../../src/v3/lib/manual-entry';

/** SC-1250: choosing an institution discarded a new account just typed in. */
describe('withInstitution', () => {
  test('keeps a new account being typed in', () => {
    const draft = {
      ...emptyAccountTarget(),
      accountMode: 'new' as const,
      newAccount: { name: 'Main', typeId: 'checking' },
    };
    const next = withInstitution(draft, 'inst-1');
    expect(next.institutionId).toBe('inst-1');
    expect(next.accountMode).toBe('new');
    expect(next.newAccount).toEqual({ name: 'Main', typeId: 'checking' });
  });

  test('clears a chosen account, which belongs to another institution', () => {
    const draft = { ...emptyAccountTarget(), institutionId: 'inst-0', accountId: 'acc-1' };
    const next = withInstitution(draft, 'inst-1');
    expect(next).toMatchObject({ institutionId: 'inst-1', accountId: '', accountMode: 'existing' });
  });
});

import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import i18n from 'i18next';

/**
 * The sessions copy counts, and it used to count with a ternary (SC-202).
 *
 *     `Sign out ${n} ${n === 1 ? 'device' : 'devices'}`
 *     `… — ${n} ${n === 1 ? 'session' : 'sessions'}, including any …`
 *
 * A ternary produces exactly two forms, which is right for English and wrong
 * for Russian (three) and Arabic (six). The phone check saw the `_other` branch
 * with 75 real sessions; this pins the one a running account rarely produces.
 *
 * Asserted against the real `en.json` through the preload, so the English here
 * is the English that ships rather than a copy of it.
 */
describe('signing out the other devices counts in whichever form the number takes', () => {
  const t = i18n.t.bind(i18n);

  test('one other device is a device, not 1 devices', () => {
    expect(t('v3.settings.sessions.signOutOthersConfirm', { count: 1 })).toBe('Sign out 1 device');
  });

  test('more than one is devices', () => {
    expect(t('v3.settings.sessions.signOutOthersConfirm', { count: 3 })).toBe('Sign out 3 devices');
  });

  test('the consequence agrees with its own count on both branches', () => {
    const one = t('v3.settings.sessions.signOutOthersConsequence', { count: 1 });
    const many = t('v3.settings.sessions.signOutOthersConsequence', { count: 75 });
    expect(one).toInclude('1 session,');
    expect(many).toInclude('75 sessions,');
    // The promise that matters is in both, and is the reason this sentence is
    // long: signing out every other device must not read as losing anything.
    expect(one).toInclude('Your data is untouched.');
    expect(many).toInclude('Your data is untouched.');
  });

  test('the trigger carries the count too, so the confirm is not the first time it is seen', () => {
    expect(t('v3.settings.sessions.signOutOthers', { count: 4 })).toBe(
      'Sign out everywhere else (4)'
    );
  });
});

describe('the destructive account copy says what goes and what stays', () => {
  const t = i18n.t.bind(i18n);

  test('deleting names the login as surviving, empty', () => {
    const copy = t('v3.settings.account.deleteConsequence');
    expect(copy).toInclude('Your login remains');
    expect(copy).toInclude('This cannot be undone.');
  });

  test('a device revoke says the data is untouched, because it is', () => {
    const copy = t('v3.settings.sessions.revokeConsequence', {
      device: 'Safari on iPhone',
      where: '203.0.113.4',
    });
    // Both interpolations are DATA — a user agent and an IP — so they are
    // values in the sentence rather than anything a translator sees.
    expect(copy).toInclude('Safari on iPhone');
    expect(copy).toInclude('203.0.113.4');
    expect(copy).toInclude('Your data is untouched');
  });
});

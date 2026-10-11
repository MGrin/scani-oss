import { describe, expect, test } from 'bun:test';
import { renderHouseholdInviteEmail } from '../../src/templates/household-invite';
import { SCANI_BRAND } from '../../src/types';

const URL_WITH_TOKEN =
  'https://app.scani.xyz/auth?returnTo=%2Fhousehold%2Faccept%3Ftoken%3Dshh_abc123';

describe('renderHouseholdInviteEmail (SC-1647)', () => {
  test('the subject names the inviter and the app', () => {
    const out = renderHouseholdInviteEmail({
      brand: SCANI_BRAND,
      url: URL_WITH_TOKEN,
      inviterName: 'Alice',
      householdName: 'Home',
    });
    expect(out.subject).toBe('Alice invited you to a household on Scani');
  });

  test('the text body carries the link verbatim and says it expires in 7 days', () => {
    const out = renderHouseholdInviteEmail({
      brand: SCANI_BRAND,
      url: URL_WITH_TOKEN,
      inviterName: 'Alice',
      householdName: 'Home',
    });
    expect(out.text).toContain(URL_WITH_TOKEN);
    expect(out.text).toContain('7 days');
  });

  test('a name the inviter typed is escaped in the HTML', () => {
    const out = renderHouseholdInviteEmail({
      brand: SCANI_BRAND,
      url: URL_WITH_TOKEN,
      inviterName: '<b>Alice</b>',
      householdName: '<script>x</script>',
    });
    expect(out.html).not.toContain('<script>x</script>');
    expect(out.html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(out.html).not.toContain('<b>Alice</b>');
  });

  test('the reader’s language is used', () => {
    const out = renderHouseholdInviteEmail({
      brand: SCANI_BRAND,
      url: URL_WITH_TOKEN,
      inviterName: 'Alice',
      householdName: 'Home',
      language: 'fr',
    });
    expect(out.subject).toContain('Alice');
    expect(out.subject).not.toBe('Alice invited you to a household on Scani');
  });
});

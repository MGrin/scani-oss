import { describe, expect, test } from 'bun:test';
import { renderOtpEmail } from '../../src/templates/otp';
import { SCANI_BRAND, SCANI_CLOUD_BRAND } from '../../src/types';

describe('renderOtpEmail', () => {
  test('subject leads with the code so it shows in the inbox preview', () => {
    const out = renderOtpEmail({ brand: SCANI_BRAND, code: '123456', type: 'sign-in' });
    expect(out.subject.startsWith('123456')).toBe(true);
  });

  test('headline copy varies by OTP type', () => {
    const signIn = renderOtpEmail({ brand: SCANI_BRAND, code: '111111', type: 'sign-in' });
    const verify = renderOtpEmail({
      brand: SCANI_BRAND,
      code: '111111',
      type: 'email-verification',
    });
    const reset = renderOtpEmail({ brand: SCANI_BRAND, code: '111111', type: 'forget-password' });
    const change = renderOtpEmail({ brand: SCANI_BRAND, code: '111111', type: 'change-email' });
    expect(signIn.html).toContain('Your sign-in code');
    expect(verify.html).toContain('Verify your email');
    expect(reset.html).toContain('Reset your password');
    expect(change.html).toContain('Confirm your new email');
  });

  test('renders code as one contiguous string with `user-select: all` so taps copy `123456` not `1 2 3 4 5 6`', () => {
    const out = renderOtpEmail({ brand: SCANI_BRAND, code: '123456', type: 'sign-in' });
    expect(out.html).toContain('>123456<');
    expect(out.html).toContain('user-select:all');
  });

  test('HTML escapes the code to defeat HTML-style poisoning attempts', () => {
    const out = renderOtpEmail({
      brand: SCANI_BRAND,
      code: '<img src=x onerror=alert(1)>',
      type: 'sign-in',
    });
    expect(out.html).not.toContain('<img src=x');
    expect(out.html).toContain('&lt;img');
  });

  test('honors a different brand', () => {
    const out = renderOtpEmail({ brand: SCANI_CLOUD_BRAND, code: '999999', type: 'sign-in' });
    expect(out.subject).toContain('Scani Cloud');
    expect(out.html).toContain('Scani Cloud');
  });
});

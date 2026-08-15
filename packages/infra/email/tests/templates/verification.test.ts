import { describe, expect, test } from 'bun:test';
import { renderVerificationEmail } from '../../src/templates/verification';
import { SCANI_BRAND, SCANI_CLOUD_BRAND } from '../../src/types';

describe('renderVerificationEmail', () => {
  test('subject is distinct from magic-link to avoid mislabeling sign-up confirmations', () => {
    const out = renderVerificationEmail({ brand: SCANI_BRAND, url: 'https://x' });
    expect(out.subject).toMatch(/^Verify your email/);
    expect(out.subject).not.toMatch(/Sign in/);
  });

  test('text body includes welcome message and URL', () => {
    const url = 'https://app.scani.xyz/verify?token=xyz';
    const out = renderVerificationEmail({ brand: SCANI_BRAND, url });
    expect(out.text).toContain('Welcome to Scani');
    expect(out.text).toContain(url);
  });

  test('escapes URL in HTML output', () => {
    const url = 'https://app.scani.xyz/verify?<bad>';
    const out = renderVerificationEmail({ brand: SCANI_BRAND, url });
    expect(out.html).not.toContain('<bad>');
    expect(out.html).toContain('&lt;bad&gt;');
  });

  test('honors brand override (different appName)', () => {
    const out = renderVerificationEmail({ brand: SCANI_CLOUD_BRAND, url: 'https://x' });
    expect(out.subject).toContain('Scani Cloud');
    expect(out.html).toContain('Scani Cloud');
  });
});

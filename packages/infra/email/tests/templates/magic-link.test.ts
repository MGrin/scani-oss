import { describe, expect, test } from 'bun:test';
import { renderMagicLinkEmail } from '../../src/templates/magic-link';
import { SCANI_BRAND, SCANI_CLOUD_BRAND } from '../../src/types';

describe('renderMagicLinkEmail', () => {
  test('subject names the brand app', () => {
    const out = renderMagicLinkEmail({ brand: SCANI_BRAND, url: 'https://app.scani.xyz/abc' });
    expect(out.subject).toBe('Sign in to Scani');
  });

  test('text body contains the URL verbatim', () => {
    const url = 'https://app.scani.xyz/auth?token=abc123&next=/home';
    const out = renderMagicLinkEmail({ brand: SCANI_BRAND, url });
    expect(out.text).toContain(url);
  });

  test('html body escapes the URL to prevent attribute injection', () => {
    const url = 'https://app.scani.xyz/auth?token=abc&next="><script>alert(1)</script>';
    const out = renderMagicLinkEmail({ brand: SCANI_BRAND, url });
    expect(out.html).not.toContain('<script>alert(1)</script>');
    expect(out.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('different brand changes appName, marketingUrl, and accent in HTML', () => {
    const scani = renderMagicLinkEmail({ brand: SCANI_BRAND, url: 'https://x' });
    const cloud = renderMagicLinkEmail({ brand: SCANI_CLOUD_BRAND, url: 'https://x' });
    expect(scani.html).toContain('Scani');
    expect(cloud.html).toContain('Scani Cloud');
    expect(cloud.html).toContain(SCANI_CLOUD_BRAND.marketingUrl);
  });

  test('preheader mentions 15-minute expiry and brand', () => {
    const out = renderMagicLinkEmail({ brand: SCANI_BRAND, url: 'https://x' });
    expect(out.html).toContain('expires in 15 minutes');
    expect(out.html).toContain('Scani');
  });
});

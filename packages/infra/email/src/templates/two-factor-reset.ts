import type { EmailBrand, EmailContent } from '../types';
import { escapeHtml, layout } from './layout';

/**
 * Sent when an admin turns two-factor sign-in off because the person lost
 * their authenticator and backup codes (SC-1646). It is the person's only
 * signal that this happened, so it says what changed and what to do if they
 * did not ask for it.
 */
export function renderTwoFactorResetEmail({
  brand,
  securityUrl,
}: {
  brand: EmailBrand;
  securityUrl: string;
}): EmailContent {
  const subject = `Two-factor sign-in was turned off on your ${brand.appName} account`;
  const text = [
    `Two-factor sign-in was turned off on your ${brand.appName} account, and every`,
    `device was signed out. Your backup codes no longer work.`,
    ``,
    `Turn it back on in Settings → Security: ${securityUrl}`,
    ``,
    `If you did not ask for this, write to ${brand.supportAddress} right away.`,
    ``,
    `— The ${brand.appName} team`,
  ].join('\n');

  const safeUrl = escapeHtml(securityUrl);
  const safeSupport = escapeHtml(brand.supportAddress);
  const content = `
    <h1 style="margin:0 0 12px 0;font-size:22px;line-height:28px;font-weight:600;color:${brand.textPrimary};">
      Two-factor sign-in was turned off.
    </h1>
    <p style="margin:0 0 20px 0;font-size:15px;line-height:22px;color:${brand.textMuted};">
      Every device was signed out, and your backup codes no longer work.
      <a href="${safeUrl}" style="color:${brand.textPrimary};">Turn it back on in Settings → Security</a>.
    </p>
    <p style="margin:0;font-size:14px;line-height:22px;color:${brand.textMuted};">
      If you did not ask for this, write to
      <a href="mailto:${safeSupport}" style="color:${brand.textPrimary};">${safeSupport}</a> right away.
    </p>
  `;
  return { subject, text, html: layout({ brand, content, preheader: subject }) };
}

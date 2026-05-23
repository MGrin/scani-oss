import type { EmailBrand, EmailContent } from '../types';
import { escapeHtml, layout } from './layout';

export function renderVerificationEmail({
  brand,
  url,
}: {
  brand: EmailBrand;
  url: string;
}): EmailContent {
  const safeUrl = escapeHtml(url);
  const subject = `Verify your email — ${brand.appName}`;
  const text = [
    `Welcome to ${brand.appName}.`,
    ``,
    `Click the link below to confirm ${brand.appName} can reach you at this address. The link works once.`,
    ``,
    url,
    ``,
    `Didn't sign up for ${brand.appName}? You can ignore this email safely.`,
  ].join('\n');

  const content = `
    <h1 style="margin:0 0 12px 0;font-size:22px;line-height:28px;font-weight:600;letter-spacing:-0.01em;color:${brand.textPrimary};">
      Confirm your email
    </h1>
    <p style="margin:0 0 24px 0;font-size:15px;line-height:22px;color:${brand.textMuted};">
      You just signed up for ${escapeHtml(brand.appName)}. Tap the button
      below to confirm we can reach you at this address.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">
      <tr>
        <td style="border-radius:10px;background:${brand.accent};">
          <a href="${safeUrl}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:${brand.accentText};text-decoration:none;border-radius:10px;">
            Verify email
          </a>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 8px 0;font-size:13px;color:${brand.textMuted};">
      Or copy and paste this URL into your browser:
    </p>
    <p style="margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;line-height:18px;color:${brand.textPrimary};word-break:break-all;background:#f5f6f8;border:1px solid ${brand.border};border-radius:8px;padding:10px 12px;">
      ${safeUrl}
    </p>
  `;

  return {
    subject,
    text,
    html: layout({
      brand,
      preheader: `Confirm your email address for ${brand.appName}.`,
      content,
    }),
  };
}

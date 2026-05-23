import type { EmailBrand, EmailContent } from '../types';
import { escapeHtml, layout } from './layout';

export function renderMagicLinkEmail({
  brand,
  url,
}: {
  brand: EmailBrand;
  url: string;
}): EmailContent {
  const safeUrl = escapeHtml(url);
  const subject = `Sign in to ${brand.appName}`;
  const text = [
    `Sign in to ${brand.appName}.`,
    ``,
    `Open this link in the same browser you started from. It works once and expires in 15 minutes.`,
    ``,
    url,
    ``,
    `Didn't request this? You can ignore this email safely.`,
  ].join('\n');

  const content = `
    <h1 style="margin:0 0 12px 0;font-size:22px;line-height:28px;font-weight:600;letter-spacing:-0.01em;color:${brand.textPrimary};">
      Your sign-in link
    </h1>
    <p style="margin:0 0 24px 0;font-size:15px;line-height:22px;color:${brand.textMuted};">
      Tap the button below to sign in to ${escapeHtml(brand.appName)}. The link
      works once and expires in 15 minutes — open it in the same browser you
      started from.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">
      <tr>
        <td style="border-radius:10px;background:${brand.accent};">
          <a href="${safeUrl}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:${brand.accentText};text-decoration:none;border-radius:10px;">
            Sign in to ${escapeHtml(brand.appName)}
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
      preheader: `Your sign-in link for ${brand.appName} — expires in 15 minutes.`,
      content,
    }),
  };
}

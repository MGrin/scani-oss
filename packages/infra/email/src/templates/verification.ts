import { fill, resolveEmailStrings } from '../i18n';
import type { EmailBrand, EmailContent } from '../types';
import { escapeHtml, layout } from './layout';

export function renderVerificationEmail({
  brand,
  url,
  language,
}: {
  brand: EmailBrand;
  url: string;
  language?: string | null;
}): EmailContent {
  const s = resolveEmailStrings(language);
  const vars = { app: brand.appName };
  const safeUrl = escapeHtml(url);
  const subject = fill(s.verification.subject, vars);
  const text = [
    fill(s.verification.textWelcome, vars),
    ``,
    fill(s.verification.textBody, vars),
    ``,
    url,
    ``,
    fill(s.verification.textIgnore, vars),
  ].join('\n');

  const content = `
    <h1 style="margin:0 0 12px 0;font-size:22px;line-height:28px;font-weight:600;letter-spacing:-0.01em;color:${brand.textPrimary};">
      ${escapeHtml(s.verification.headline)}
    </h1>
    <p style="margin:0 0 24px 0;font-size:15px;line-height:22px;color:${brand.textMuted};">
      ${escapeHtml(fill(s.verification.body, vars))}
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">
      <tr>
        <td style="border-radius:10px;background:${brand.accent};">
          <a href="${safeUrl}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:${brand.accentText};text-decoration:none;border-radius:10px;">
            ${escapeHtml(s.verification.button)}
          </a>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 8px 0;font-size:13px;color:${brand.textMuted};">
      ${escapeHtml(s.common.orCopyUrl)}
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
      strings: s,
      preheader: fill(s.verification.preheader, vars),
      content,
    }),
  };
}

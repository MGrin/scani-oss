import { fill, resolveEmailStrings } from '../i18n';
import type { EmailBrand, EmailContent } from '../types';
import { escapeHtml, layout } from './layout';

/**
 * The invite to a household (SC-1647). The URL carries the invite token, so
 * the mail is sent as an auth template and its links are never tracked.
 */
export function renderHouseholdInviteEmail({
  brand,
  url,
  inviterName,
  householdName,
  language,
}: {
  brand: EmailBrand;
  url: string;
  inviterName: string;
  householdName: string;
  language?: string | null;
}): EmailContent {
  const s = resolveEmailStrings(language).householdInvite;
  const common = resolveEmailStrings(language);
  const vars = { app: brand.appName, inviter: inviterName, household: householdName };
  const safeUrl = escapeHtml(url);
  const text = [fill(s.textIntro, vars), ``, s.textBody, ``, url, ``, s.expiry].join('\n');

  const content = `
    <h1 style="margin:0 0 12px 0;font-size:22px;line-height:28px;font-weight:600;letter-spacing:-0.01em;color:${brand.textPrimary};">
      ${escapeHtml(fill(s.headline, vars))}
    </h1>
    <p style="margin:0 0 24px 0;font-size:15px;line-height:22px;color:${brand.textMuted};">
      ${escapeHtml(fill(s.body, vars))}
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">
      <tr>
        <td style="border-radius:10px;background:${brand.accent};">
          <a href="${safeUrl}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:${brand.accentText};text-decoration:none;border-radius:10px;">
            ${escapeHtml(s.button)}
          </a>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 16px 0;font-size:13px;color:${brand.textMuted};">
      ${escapeHtml(s.expiry)}
    </p>
    <p style="margin:0 0 8px 0;font-size:13px;color:${brand.textMuted};">
      ${escapeHtml(common.common.orCopyUrl)}
    </p>
    <p style="margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;line-height:18px;color:${brand.textPrimary};word-break:break-all;background:#f5f6f8;border:1px solid ${brand.border};border-radius:8px;padding:10px 12px;">
      ${safeUrl}
    </p>
  `;

  return {
    subject: fill(s.subject, vars),
    text,
    html: layout({ brand, strings: common, preheader: fill(s.preheader, vars), content }),
  };
}

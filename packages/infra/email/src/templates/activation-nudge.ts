import { fill, resolveEmailStrings } from '../i18n';
import type { EmailBrand, EmailContent } from '../types';
import { escapeHtml, layout } from './layout';

/**
 * The one reminder to an account that signed up and added nothing (SC-1503).
 *
 * It is sent once, ever, so the letter says so: a reader who knows there is no
 * second one has no reason to reach for the spam button.
 *
 * Both footer links carry `data-no-track`. The unsubscribe URL holds the
 * account's bearer token and the click redirect would hand it to the tracking
 * endpoint (SC-1507); the privacy link is not a credential, but a reader
 * checking how their data is handled should not be counted doing it.
 */
export function renderActivationNudgeEmail({
  brand,
  name,
  language,
  appUrl,
  unsubscribeUrl,
  privacyUrl,
}: {
  brand: EmailBrand;
  name: string;
  language?: string | null;
  appUrl: string;
  unsubscribeUrl: string;
  privacyUrl: string;
}): EmailContent {
  const strings = resolveEmailStrings(language);
  const s = strings.activationNudge;
  const vars = { app: brand.appName };
  const first = name.trim().split(/\s+/)[0] ?? '';
  const greeting = first ? fill(s.greeting, { name: first }) : s.greetingNoName;

  const text = [
    greeting,
    ``,
    fill(s.body, vars),
    ``,
    fill(s.textOpen, { ...vars, url: appUrl }),
    ``,
    s.once,
    ``,
    fill(s.textUnsubscribe, { url: unsubscribeUrl }),
    fill(s.textPrivacy, { url: privacyUrl }),
  ].join('\n');

  const content = `
    <p style="margin:0 0 4px 0;font-size:13px;color:${brand.textMuted};">
      ${escapeHtml(greeting)}
    </p>
    <h1 style="margin:0;font-size:24px;line-height:32px;font-weight:600;letter-spacing:-0.02em;color:${brand.textPrimary};">
      ${escapeHtml(s.headline)}
    </h1>
    <p style="margin:10px 0 0 0;font-size:15px;line-height:22px;color:${brand.textMuted};">
      ${escapeHtml(fill(s.body, vars))}
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 0 0;">
      <tr>
        <td style="border-radius:10px;background:${brand.accent};">
          <a href="${escapeHtml(appUrl)}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:${brand.accentText};text-decoration:none;border-radius:10px;">
            ${escapeHtml(fill(s.button, vars))}
          </a>
        </td>
      </tr>
    </table>
    <p style="margin:24px 0 0 0;font-size:13px;color:${brand.textMuted};">
      ${escapeHtml(s.once)}
    </p>
  `;

  const muted = `color:${brand.textMuted};text-decoration:underline;`;
  const footerNote = fill(escapeHtml(s.footer), {
    appLink: `<a href="${escapeHtml(brand.appUrl)}" style="color:${brand.textMuted};">${escapeHtml(brand.appName)}</a>`,
    unsubscribeLink: `<a href="${escapeHtml(unsubscribeUrl)}" data-no-track style="${muted}">${escapeHtml(s.unsubscribe)}</a>`,
    privacyLink: `<a href="${escapeHtml(privacyUrl)}" data-no-track style="${muted}">${escapeHtml(s.privacy)}</a>`,
  });

  return {
    subject: fill(s.subject, vars),
    text,
    html: layout({
      brand,
      strings,
      preheader: fill(s.preheader, vars),
      content,
      footerNote,
    }),
  };
}

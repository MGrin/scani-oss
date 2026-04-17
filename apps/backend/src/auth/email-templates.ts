/**
 * Transactional email templates for Better-Auth flows (magic link + OTP).
 *
 * Both templates share a minimalist, brand-neutral layout that renders
 * reliably in Gmail / Apple Mail / Outlook: a single white card on a soft
 * grey background, system fonts, explicit table widths where clients still
 * need them. Inline styles only — no <style> blocks (Outlook & some webmail
 * strip them).
 */

const BRAND = {
  appName: 'Scani',
  appUrl: 'https://app.scani.xyz',
  marketingUrl: 'https://scani.xyz',
  supportAddress: 'welcome@scani.xyz',
  accent: '#111111',
  accentText: '#ffffff',
  bodyBg: '#f5f6f8',
  cardBg: '#ffffff',
  textPrimary: '#0f172a',
  textMuted: '#64748b',
  border: '#e2e8f0',
} as const;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout({ preheader, content }: { preheader: string; content: string }): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light only">
    <meta name="supported-color-schemes" content="light only">
    <title>${escapeHtml(BRAND.appName)}</title>
  </head>
  <body style="margin:0;padding:0;background:${BRAND.bodyBg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Inter',Roboto,Helvetica,Arial,sans-serif;color:${BRAND.textPrimary};-webkit-font-smoothing:antialiased;">
    <!-- Preheader: shown in inbox preview, hidden in body -->
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">
      ${escapeHtml(preheader)}
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.bodyBg};padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;width:100%;background:${BRAND.cardBg};border:1px solid ${BRAND.border};border-radius:14px;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px 0 32px;">
                <a href="${BRAND.marketingUrl}" style="text-decoration:none;color:${BRAND.textPrimary};font-weight:600;font-size:18px;letter-spacing:-0.01em;">
                  ${escapeHtml(BRAND.appName)}
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 32px 32px;">
                ${content}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px;background:#fafbfc;border-top:1px solid ${BRAND.border};font-size:12px;line-height:18px;color:${BRAND.textMuted};">
                You're getting this email because someone requested sign-in to
                <a href="${BRAND.appUrl}" style="color:${BRAND.textMuted};">${escapeHtml(BRAND.appName)}</a>
                using this address. If that wasn't you, you can safely ignore this message — no account action was taken.
              </td>
            </tr>
          </table>
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;width:100%;margin-top:16px;">
            <tr>
              <td align="center" style="font-size:12px;color:${BRAND.textMuted};">
                ${escapeHtml(BRAND.appName)} &middot; Personal wealth, one place
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

export function renderMagicLinkEmail({ url }: { url: string }): EmailContent {
  const safeUrl = escapeHtml(url);
  const subject = `Sign in to ${BRAND.appName}`;
  const text = [
    `Sign in to ${BRAND.appName}.`,
    ``,
    `Open this link in the same browser you started from. It works once and expires in 15 minutes.`,
    ``,
    url,
    ``,
    `Didn't request this? You can ignore this email safely.`,
  ].join('\n');

  const content = `
    <h1 style="margin:0 0 12px 0;font-size:22px;line-height:28px;font-weight:600;letter-spacing:-0.01em;color:${BRAND.textPrimary};">
      Your sign-in link
    </h1>
    <p style="margin:0 0 24px 0;font-size:15px;line-height:22px;color:${BRAND.textMuted};">
      Tap the button below to sign in to ${escapeHtml(BRAND.appName)}. The link
      works once and expires in 15 minutes — open it in the same browser you
      started from.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">
      <tr>
        <td style="border-radius:10px;background:${BRAND.accent};">
          <a href="${safeUrl}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:${BRAND.accentText};text-decoration:none;border-radius:10px;">
            Sign in to ${escapeHtml(BRAND.appName)}
          </a>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 8px 0;font-size:13px;color:${BRAND.textMuted};">
      Or copy and paste this URL into your browser:
    </p>
    <p style="margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;line-height:18px;color:${BRAND.textPrimary};word-break:break-all;background:#f5f6f8;border:1px solid ${BRAND.border};border-radius:8px;padding:10px 12px;">
      ${safeUrl}
    </p>
  `;

  return {
    subject,
    text,
    html: layout({
      preheader: `Your sign-in link for ${BRAND.appName} — expires in 15 minutes.`,
      content,
    }),
  };
}

export function renderOtpEmail({
  code,
  type,
}: {
  code: string;
  type: 'sign-in' | 'email-verification' | 'forget-password' | 'change-email';
}): EmailContent {
  const headline =
    type === 'email-verification'
      ? 'Verify your email'
      : type === 'forget-password'
        ? 'Reset your password'
        : type === 'change-email'
          ? 'Confirm your new email'
          : 'Your sign-in code';
  const purpose =
    type === 'email-verification'
      ? `Enter this code to verify your email on ${BRAND.appName}.`
      : type === 'forget-password'
        ? `Enter this code to continue resetting your password on ${BRAND.appName}.`
        : type === 'change-email'
          ? `Enter this code to confirm your new email on ${BRAND.appName}.`
          : `Enter this code in ${BRAND.appName} to finish signing in.`;
  const subject = `${code} — ${headline.toLowerCase()} · ${BRAND.appName}`;
  const text = [
    `${headline}`,
    ``,
    purpose,
    ``,
    `Code: ${code}`,
    ``,
    `This code works once and expires in 5 minutes. If you didn't request it, ignore this email.`,
  ].join('\n');

  // Space out the digits so clients that auto-hide "long numbers"
  // (and the "123 456" Gmail OTP UI) both render it well.
  const spacedCode = escapeHtml(code.split('').join(' '));

  const content = `
    <h1 style="margin:0 0 12px 0;font-size:22px;line-height:28px;font-weight:600;letter-spacing:-0.01em;color:${BRAND.textPrimary};">
      ${escapeHtml(headline)}
    </h1>
    <p style="margin:0 0 24px 0;font-size:15px;line-height:22px;color:${BRAND.textMuted};">
      ${escapeHtml(purpose)} The code works once and expires in 5 minutes.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 24px 0;">
      <tr>
        <td align="center" style="background:#f5f6f8;border:1px solid ${BRAND.border};border-radius:12px;padding:22px 16px;">
          <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:34px;line-height:40px;font-weight:600;letter-spacing:0.12em;color:${BRAND.textPrimary};">
            ${spacedCode}
          </div>
        </td>
      </tr>
    </table>
    <p style="margin:0;font-size:13px;line-height:20px;color:${BRAND.textMuted};">
      Copy the code and paste it back into the ${escapeHtml(BRAND.appName)} app on the device you started from.
    </p>
  `;

  return {
    subject,
    text,
    html: layout({
      preheader: `${code} is your ${BRAND.appName} ${type === 'sign-in' ? 'sign-in' : 'verification'} code (expires in 5 min).`,
      content,
    }),
  };
}

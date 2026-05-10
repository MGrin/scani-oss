import type { EmailBrand } from '../types';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function layout({
  brand,
  preheader,
  content,
  footerNote,
}: {
  brand: EmailBrand;
  preheader: string;
  content: string;
  // Override the default sign-in footer for emails that aren't auth-
  // related (e.g. the beta-preview waitlist confirmation). When omitted,
  // the body keeps the canonical "someone requested sign-in" language
  // used by the auth templates. Caller is responsible for HTML-escaping
  // any interpolated values inside the override.
  footerNote?: string;
}): string {
  const footerHtml =
    footerNote ??
    `You're getting this email because someone requested sign-in to
                <a href="${brand.appUrl}" style="color:${brand.textMuted};">${escapeHtml(brand.appName)}</a>
                using this address. If that wasn't you, you can safely ignore this message — no account action was taken.`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light only">
    <meta name="supported-color-schemes" content="light only">
    <title>${escapeHtml(brand.appName)}</title>
  </head>
  <body style="margin:0;padding:0;background:${brand.bodyBg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Inter',Roboto,Helvetica,Arial,sans-serif;color:${brand.textPrimary};-webkit-font-smoothing:antialiased;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">
      ${escapeHtml(preheader)}
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${brand.bodyBg};padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;width:100%;background:${brand.cardBg};border:1px solid ${brand.border};border-radius:14px;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px 0 32px;">
                <a href="${brand.marketingUrl}" style="text-decoration:none;color:${brand.textPrimary};font-weight:600;font-size:18px;letter-spacing:-0.01em;">
                  ${escapeHtml(brand.appName)}
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 32px 32px;">
                ${content}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px;background:#fafbfc;border-top:1px solid ${brand.border};font-size:12px;line-height:18px;color:${brand.textMuted};">
                ${footerHtml}
              </td>
            </tr>
          </table>
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;width:100%;margin-top:16px;">
            <tr>
              <td align="center" style="font-size:12px;color:${brand.textMuted};">
                ${escapeHtml(brand.appName)} &middot; Personal wealth, one place
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

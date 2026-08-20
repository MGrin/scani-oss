import { fill, type OtpStringKey, resolveEmailStrings } from '../i18n';
import type { EmailBrand, EmailContent, OtpType } from '../types';
import { escapeHtml, layout } from './layout';

/** `OtpType` is the wire spelling; the bundle keys read as identifiers. */
const STRING_KEY: Record<OtpType, OtpStringKey> = {
  'sign-in': 'signIn',
  'email-verification': 'emailVerification',
  'forget-password': 'forgetPassword',
  'change-email': 'changeEmail',
};

export function renderOtpEmail({
  brand,
  code,
  type,
  language,
}: {
  brand: EmailBrand;
  code: string;
  type: OtpType;
  language?: string | null;
}): EmailContent {
  const s = resolveEmailStrings(language);
  const key = STRING_KEY[type];
  const vars = { app: brand.appName, code };
  const headline = s.otp.headline[key];
  const purpose = fill(s.otp.purpose[key], vars);
  const subject = `${code} — ${s.otp.subjectPurpose[key]} · ${brand.appName}`;
  const text = [headline, ``, purpose, ``, fill(s.otp.codeLabel, vars), ``, s.otp.expiryText].join(
    '\n'
  );

  const safeCode = escapeHtml(code);

  // The code renders as one contiguous string with `letter-spacing` so:
  //   - it never overflows narrow phone viewports (~320px),
  //   - tapping it on mobile (`user-select: all`) selects the whole code,
  //   - the clipboard gets `123456` not `1 2 3 4 5 6`.
  const content = `
    <h1 style="margin:0 0 12px 0;font-size:22px;line-height:28px;font-weight:600;letter-spacing:-0.01em;color:${brand.textPrimary};">
      ${escapeHtml(headline)}
    </h1>
    <p style="margin:0 0 24px 0;font-size:15px;line-height:22px;color:${brand.textMuted};">
      ${escapeHtml(purpose)} ${escapeHtml(s.otp.expiryHtml)}
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 20px 0;">
      <tr>
        <td align="center" style="background:#f5f6f8;border:1px solid ${brand.border};border-radius:12px;padding:22px 16px;">
          <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:34px;line-height:40px;font-weight:700;letter-spacing:0.32em;color:${brand.textPrimary};white-space:nowrap;-webkit-user-select:all;-moz-user-select:all;-ms-user-select:all;user-select:all;cursor:pointer;">${safeCode}</div>
        </td>
      </tr>
    </table>
    <p style="margin:0;font-size:13px;line-height:20px;color:${brand.textMuted};">
      ${escapeHtml(fill(s.otp.tapCode, vars))}
    </p>
  `;

  return {
    subject,
    text,
    html: layout({
      brand,
      strings: s,
      preheader: fill(
        type === 'sign-in' ? s.otp.preheaderSignIn : s.otp.preheaderVerification,
        vars
      ),
      content,
    }),
  };
}

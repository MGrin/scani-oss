import type { EmailBrand, EmailContent, OtpType } from '../types';
import { escapeHtml, layout } from './layout';

export function renderOtpEmail({
  brand,
  code,
  type,
}: {
  brand: EmailBrand;
  code: string;
  type: OtpType;
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
      ? `Enter this code to verify your email on ${brand.appName}.`
      : type === 'forget-password'
        ? `Enter this code to continue resetting your password on ${brand.appName}.`
        : type === 'change-email'
          ? `Enter this code to confirm your new email on ${brand.appName}.`
          : `Enter this code in ${brand.appName} to finish signing in.`;
  const subject = `${code} — ${headline.toLowerCase()} · ${brand.appName}`;
  const text = [
    `${headline}`,
    ``,
    purpose,
    ``,
    `Code: ${code}`,
    ``,
    `This code works once and expires in 5 minutes. If you didn't request it, ignore this email.`,
  ].join('\n');

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
      ${escapeHtml(purpose)} It works once and expires in 5 minutes.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 20px 0;">
      <tr>
        <td align="center" style="background:#f5f6f8;border:1px solid ${brand.border};border-radius:12px;padding:22px 16px;">
          <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:34px;line-height:40px;font-weight:700;letter-spacing:0.32em;color:${brand.textPrimary};white-space:nowrap;-webkit-user-select:all;-moz-user-select:all;-ms-user-select:all;user-select:all;cursor:pointer;">${safeCode}</div>
        </td>
      </tr>
    </table>
    <p style="margin:0;font-size:13px;line-height:20px;color:${brand.textMuted};">
      Tap the code to select it, then paste it into ${escapeHtml(brand.appName)} on the device you started from.
    </p>
  `;

  return {
    subject,
    text,
    html: layout({
      brand,
      preheader: `${code} is your ${brand.appName} ${type === 'sign-in' ? 'sign-in' : 'verification'} code (expires in 5 min).`,
      content,
    }),
  };
}

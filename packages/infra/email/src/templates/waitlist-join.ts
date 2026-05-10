import type { EmailBrand, EmailContent } from '../types';
import { escapeHtml, layout } from './layout';

/**
 * Confirmation email sent when someone joins the beta-preview
 * waitlist via the public landing page (`apps/frontend/landing/src/
 * components/sections/BetaPromise.tsx` → `waitlistRouter.join`).
 *
 * Goal: give the user durable proof of signup in their inbox, reinforce
 * the 1-year-free promise, and offer a low-friction next step (sign up
 * on app.scani.xyz with the same address — the grandfathering job will
 * link the two when billing turns on).
 *
 * Visual language matches the auth emails (magic-link / OTP) — same
 * `layout()` wrapper, same brand tokens, same accent button — so users
 * who already see Scani auth mail recognise the sender.
 */
export function renderWaitlistJoinEmail({
  brand,
  email,
}: {
  brand: EmailBrand;
  email: string;
}): EmailContent {
  const subject = `You're on the ${brand.appName} beta waitlist`;
  const text = [
    `You're in.`,
    ``,
    `Thanks for joining the ${brand.appName} beta waitlist with ${email}.`,
    `Your slot is locked in: when subscriptions launch, you'll get 1 year of`,
    `every paid tier, free.`,
    ``,
    `What happens next?`,
    `  • We'll email you the moment billing turns on — no spam in between.`,
    `  • Nothing else to do; just keep an eye on this inbox.`,
    ``,
    `Want to start using ${brand.appName} right now? Sign up at ${brand.appUrl}`,
    `with the same address and your beta perk auto-applies.`,
    ``,
    `If you didn't sign up, you can ignore this email — we won't contact`,
    `this address again.`,
  ].join('\n');

  const safeEmail = escapeHtml(email);
  const safeAppUrl = escapeHtml(brand.appUrl);
  const safeAppName = escapeHtml(brand.appName);

  const content = `
    <h1 style="margin:0 0 12px 0;font-size:22px;line-height:28px;font-weight:600;letter-spacing:-0.01em;color:${brand.textPrimary};">
      You're in.
    </h1>
    <p style="margin:0 0 20px 0;font-size:15px;line-height:22px;color:${brand.textMuted};">
      Thanks for joining the ${safeAppName} beta waitlist with
      <span style="color:${brand.textPrimary};font-weight:500;">${safeEmail}</span>.
      Your slot is locked in: when subscriptions launch, you'll get
      <strong style="color:${brand.textPrimary};">1 year of every paid tier, free</strong>.
    </p>
    <p style="margin:0 0 8px 0;font-size:13px;font-weight:600;color:${brand.textPrimary};text-transform:uppercase;letter-spacing:0.06em;">
      What happens next
    </p>
    <ul style="margin:0 0 24px 0;padding:0 0 0 20px;font-size:14px;line-height:22px;color:${brand.textMuted};">
      <li style="margin-bottom:6px;">We'll email you the moment billing turns on — no spam in between.</li>
      <li>Nothing else to do; just keep an eye on this inbox.</li>
    </ul>
    <p style="margin:0 0 20px 0;font-size:14px;line-height:22px;color:${brand.textMuted};">
      Want to start using ${safeAppName} right now? Sign up with the same
      address and your beta perk auto-applies.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0;">
      <tr>
        <td style="border-radius:10px;background:${brand.accent};">
          <a href="${safeAppUrl}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:${brand.accentText};text-decoration:none;border-radius:10px;">
            Open ${safeAppName}
          </a>
        </td>
      </tr>
    </table>
  `;

  return {
    subject,
    text,
    html: layout({
      brand,
      preheader: `You're on the ${brand.appName} beta waitlist — 1 year of paid tiers, free, when billing launches.`,
      content,
      footerNote: `You're getting this email because someone joined the ${safeAppName} beta-preview waitlist using
                <a href="${safeAppUrl}" style="color:${brand.textMuted};">${safeAppName}</a>
                with this address. If that wasn't you, ignore this message — we won't contact this address again.`,
    }),
  };
}

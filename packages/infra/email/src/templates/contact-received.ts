import type { EmailBrand, EmailContent } from '../types';
import { escapeHtml, layout } from './layout';

/**
 * Confirmation email sent to someone who submits the public contact form
 * (`apps/frontend/landing/src/components/sections/Contact.tsx` →
 * `contactRouter.submit`).
 *
 * It's a receipt, not a thread: the team replies to the original message
 * separately, so this mail deliberately doesn't invite a reply. Visual
 * language matches the auth + waitlist emails — same `layout()` wrapper
 * and brand tokens — so the sender recognises Scani.
 */
export function renderContactReceivedEmail({
  brand,
  name,
}: {
  brand: EmailBrand;
  name: string;
}): EmailContent {
  const trimmed = name.trim();
  const firstName = trimmed.split(/\s+/)[0] || trimmed;
  const subject = `We got your message — ${brand.appName} support`;
  const text = [
    `Hi ${firstName},`,
    ``,
    `Thanks for reaching out to ${brand.appName}. Your message landed with`,
    `our team and a human will reply to this address, usually within one`,
    `business day.`,
    ``,
    `No need to reply — this is just a receipt. We'll follow up on your`,
    `original question directly.`,
    ``,
    `Need to add something? Write to ${brand.supportAddress}.`,
    ``,
    `— The ${brand.appName} team`,
  ].join('\n');

  const safeFirstName = escapeHtml(firstName);
  const safeAppName = escapeHtml(brand.appName);
  const safeSupport = escapeHtml(brand.supportAddress);

  const content = `
    <h1 style="margin:0 0 12px 0;font-size:22px;line-height:28px;font-weight:600;letter-spacing:-0.01em;color:${brand.textPrimary};">
      We got your message.
    </h1>
    <p style="margin:0 0 20px 0;font-size:15px;line-height:22px;color:${brand.textMuted};">
      Hi <span style="color:${brand.textPrimary};font-weight:500;">${safeFirstName}</span>,
      thanks for reaching out to ${safeAppName}. Your message landed with our
      team and a human will reply to this address — usually within
      <strong style="color:${brand.textPrimary};">one business day</strong>.
    </p>
    <p style="margin:0 0 20px 0;font-size:14px;line-height:22px;color:${brand.textMuted};">
      No need to reply to this email — it's just a receipt. We'll follow up
      on your original question directly.
    </p>
    <p style="margin:0;font-size:14px;line-height:22px;color:${brand.textMuted};">
      Need to add something? Write to
      <a href="mailto:${safeSupport}" style="color:${brand.textPrimary};">${safeSupport}</a>.
    </p>
  `;

  return {
    subject,
    text,
    html: layout({
      brand,
      preheader: `Thanks for contacting ${brand.appName} — we'll reply within one business day.`,
      content,
      footerNote: `You're getting this email because someone submitted the contact form on
                <a href="${escapeHtml(brand.marketingUrl)}" style="color:${brand.textMuted};">${safeAppName}</a>
                using this address. If that wasn't you, ignore this message — no action was taken.`,
    }),
  };
}

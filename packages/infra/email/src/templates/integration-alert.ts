import type { EmailBrand, EmailContent } from '../types';
import { escapeHtml, layout } from './layout';

/**
 * One integration this account can no longer sync (SC-459).
 *
 * Declared HERE rather than imported from `@scani/domain`, for the same reason
 * `WeeklyDigestContent` is: the dependency runs domain → email, so the template
 * cannot reach back. It is structurally identical to the domain's type on
 * purpose, so a field that changes shape on one side fails to compile on the
 * other rather than rendering an empty section.
 */
export interface StaleIntegrationItem {
  name: string;
  /**
   * `never-synced` — the connection has credentials but has never produced an
   * account, a state the hourly sync skips before it even reads the credential
   * and can therefore never recover from on its own (SC-248).
   * `stopped` — it worked, and then stopped.
   */
  reason: 'never-synced' | 'stopped';
}

const REASON_TEXT: Record<StaleIntegrationItem['reason'], string> = {
  'never-synced': 'connected, but nothing has ever come through',
  stopped: 'has stopped sending updates',
};

/**
 * The first thing Scani has ever told a user without being asked (SC-459).
 *
 * What the letter has to achieve, in order: say which connection is broken,
 * say what that costs them RIGHT NOW — the figures they are looking at are
 * stale and they have no way to know it — and give them one link that lands on
 * the page where it is fixed. It states no date, promises no repair, and asks
 * for nothing.
 *
 * The unsubscribe is in the FOOTER OVERRIDE rather than the body so it survives
 * every future edit above it, and its sentence names what it does NOT cover:
 * this stream and the weekly digest are opted out of separately, and a reader
 * who clicks expecting silence and keeps getting mail learns the link is a lie.
 */
export function renderIntegrationAlertEmail({
  brand,
  name,
  integrations,
  integrationsUrl,
  unsubscribeUrl,
  digestUnsubscribeUrl,
}: {
  brand: EmailBrand;
  name: string;
  integrations: StaleIntegrationItem[];
  /** Deep link to the page where a connection is reconnected. */
  integrationsUrl: string;
  unsubscribeUrl: string;
  /** The other stream's link, offered in the footer so "stop all mail" is one more click. */
  digestUnsubscribeUrl: string;
}): EmailContent {
  const greeting = name.trim().split(/\s+/)[0] || 'there';
  const one = integrations.length === 1;
  const headline = one
    ? `${integrations[0]?.name} is not syncing`
    : `${integrations.length} connections are not syncing`;

  const textLines = [
    `Hi ${greeting},`,
    ``,
    one
      ? `${integrations[0]?.name} ${REASON_TEXT[integrations[0]?.reason ?? 'stopped']}.`
      : `${integrations.length} of your connections have stopped syncing:`,
  ];
  if (!one) {
    for (const item of integrations) {
      textLines.push(`  • ${item.name} — ${REASON_TEXT[item.reason]}`);
    }
  }
  textLines.push(
    ``,
    // The consequence, not the event. "X is not syncing" is a fact about our
    // infrastructure; this is the sentence that says why they should care.
    `Until ${one ? 'it is' : 'they are'} reconnected, the balances and totals in ${brand.appName} do not include anything that has happened there since.`,
    ``,
    `Reconnect: ${integrationsUrl}`,
    ``,
    `Stop these alerts: ${unsubscribeUrl}`
  );

  const listHtml = integrations
    .map(
      (item) => `<tr>
        <td style="padding:6px 0;color:${brand.textPrimary};font-weight:500;">${escapeHtml(item.name)}</td>
        <td align="right" style="padding:6px 0;color:${brand.textMuted};font-size:13px;">${escapeHtml(
          REASON_TEXT[item.reason]
        )}</td>
      </tr>`
    )
    .join('');

  const content = `
    <p style="margin:0 0 4px 0;font-size:13px;color:${brand.textMuted};">
      Hi ${escapeHtml(greeting)},
    </p>
    <h1 style="margin:0;font-size:24px;line-height:32px;font-weight:600;letter-spacing:-0.02em;color:${brand.textPrimary};">
      ${escapeHtml(headline)}
    </h1>
    <p style="margin:10px 0 0 0;font-size:14px;line-height:22px;color:${brand.textMuted};">
      Until ${one ? 'it is' : 'they are'} reconnected, the balances and totals in
      ${escapeHtml(brand.appName)} do not include anything that has happened there since.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 0 0;font-size:14px;line-height:22px;border-top:1px solid ${brand.border};">
      ${listHtml}
    </table>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 0 0;">
      <tr>
        <td style="border-radius:10px;background:${brand.accent};">
          <a href="${escapeHtml(integrationsUrl)}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:${brand.accentText};text-decoration:none;border-radius:10px;">
            Reconnect ${one ? 'it' : 'them'}
          </a>
        </td>
      </tr>
    </table>
  `;

  return {
    subject: `${brand.appName}: ${headline}`,
    text: textLines.join('\n'),
    html: layout({
      brand,
      preheader: `Figures in ${brand.appName} are missing anything that has happened there since.`,
      content,
      footerNote: `You get this because a connection you set up in
                <a href="${escapeHtml(integrationsUrl)}" style="color:${brand.textMuted};">${escapeHtml(brand.appName)}</a>
                stopped working.
                <a href="${escapeHtml(unsubscribeUrl)}" style="color:${brand.textMuted};text-decoration:underline;">Stop these alerts</a>
                — one click, no sign-in. That leaves the weekly digest running;
                <a href="${escapeHtml(digestUnsubscribeUrl)}" style="color:${brand.textMuted};text-decoration:underline;">stop that too</a>.`,
    }),
  };
}

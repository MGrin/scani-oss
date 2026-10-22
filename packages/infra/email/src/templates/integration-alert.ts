import { fill, resolveEmailStrings } from '../i18n';
import type { EmailBrand, EmailContent } from '../types';
import { escapeHtml, layout } from './layout';
import { oneClickUnsubscribeHeaders } from './unsubscribe-headers';

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
  language,
  integrations,
  integrationsUrl,
  unsubscribeUrl,
  digestUnsubscribeUrl,
}: {
  brand: EmailBrand;
  name: string;
  language?: string | null;
  integrations: StaleIntegrationItem[];
  /** Deep link to the page where a connection is reconnected. */
  integrationsUrl: string;
  unsubscribeUrl: string;
  /** The other stream's link, offered in the footer so "stop all mail" is one more click. */
  digestUnsubscribeUrl: string;
}): EmailContent {
  const strings = resolveEmailStrings(language);
  const s = strings.integrationAlert;
  const app = brand.appName;
  const first = name.trim().split(/\s+/)[0] ?? '';
  const greeting = first ? fill(s.greeting, { name: first }) : s.greetingNoName;
  const one = integrations.length === 1;
  const count = String(integrations.length);
  const reason = (item: StaleIntegrationItem) =>
    item.reason === 'never-synced' ? s.reasonNeverSynced : s.reasonStopped;
  const headline = one
    ? fill(s.headlineOne, { name: integrations[0]?.name ?? '' })
    : fill(s.headlineMany, { count });
  // The consequence, not the event. "X is not syncing" is a fact about our
  // infrastructure; this is the sentence that says why they should care.
  const consequence = fill(one ? s.consequenceOne : s.consequenceMany, { app });

  // The subject names no connection (SC-1721): mx.yandex.ru refused "Scani:
  // Bybit is not syncing" as spam, because a known exchange's name over a
  // "Reconnect" link is the shape of credential phishing. The body names it.
  const textLines = [greeting, ``];
  if (one) {
    textLines.push(`${integrations[0]?.name} ${reason(integrations[0] as StaleIntegrationItem)}.`);
  } else {
    textLines.push(fill(s.listIntro, { count }));
    for (const item of integrations) textLines.push(`  • ${item.name} — ${reason(item)}`);
  }
  textLines.push(
    ``,
    consequence,
    ``,
    fill(one ? s.textActionOne : s.textActionMany, { app, url: integrationsUrl }),
    ``,
    fill(s.textStop, { url: unsubscribeUrl })
  );

  const listHtml = integrations
    .map(
      (item) => `<tr>
        <td style="padding:6px 0;color:${brand.textPrimary};font-weight:500;">${escapeHtml(item.name)}</td>
        <td align="right" style="padding:6px 0;color:${brand.textMuted};font-size:13px;">${escapeHtml(
          reason(item)
        )}</td>
      </tr>`
    )
    .join('');

  const content = `
    <p style="margin:0 0 4px 0;font-size:13px;color:${brand.textMuted};">
      ${escapeHtml(greeting)}
    </p>
    <h1 style="margin:0;font-size:24px;line-height:32px;font-weight:600;letter-spacing:-0.02em;color:${brand.textPrimary};">
      ${escapeHtml(headline)}
    </h1>
    <p style="margin:10px 0 0 0;font-size:14px;line-height:22px;color:${brand.textMuted};">
      ${escapeHtml(consequence)}
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 0 0;font-size:14px;line-height:22px;border-top:1px solid ${brand.border};">
      ${listHtml}
    </table>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 0 0;">
      <tr>
        <td style="border-radius:10px;background:${brand.accent};">
          <a href="${escapeHtml(integrationsUrl)}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:${brand.accentText};text-decoration:none;border-radius:10px;">
            ${escapeHtml(s.button)}
          </a>
        </td>
      </tr>
    </table>
  `;

  const muted = `color:${brand.textMuted};text-decoration:underline;`;
  const footerNote = fill(escapeHtml(s.footer), {
    appLink: `<a href="${escapeHtml(integrationsUrl)}" style="color:${brand.textMuted};">${escapeHtml(app)}</a>`,
    stopLink: `<a href="${escapeHtml(unsubscribeUrl)}" data-no-track style="${muted}">${escapeHtml(s.stop)}</a>`,
    digestLink: `<a href="${escapeHtml(digestUnsubscribeUrl)}" data-no-track style="${muted}">${escapeHtml(s.stopDigest)}</a>`,
  });

  return {
    subject: fill(s.subject, { app }),
    text: textLines.join('\n'),
    html: layout({ brand, strings, preheader: fill(s.preheader, { app }), content, footerNote }),
    headers: oneClickUnsubscribeHeaders(unsubscribeUrl),
  };
}

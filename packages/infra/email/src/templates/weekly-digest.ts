import type { EmailBrand, EmailContent } from '../types';
import { escapeHtml, layout } from './layout';

/**
 * The digest's shape, declared HERE rather than imported from `@scani/domain`.
 *
 * The dependency runs domain → email, so the template cannot reach back for
 * `WeeklyDigest`. It is structurally identical on purpose: the service's type
 * is assignable to this one, so a field that changes shape on one side fails
 * to compile on the other rather than rendering an empty section.
 *
 * Every money value arrives ALREADY FORMATTED. Which currency a figure is in,
 * and how many decimals it deserves, are questions only the caller can answer —
 * the base currency for the headline, the bill's own currency for a bill — and
 * a template that formatted them would have to be told both.
 */
export interface WeeklyDigestContent {
  netWorth: string;
  asOf: string;
  change: { amount: string; percent: string | null; direction: 'up' | 'down' | 'flat' } | null;
  movers: Array<{
    symbol: string;
    amount: string;
    percent: string | null;
    direction: 'up' | 'down' | 'flat';
  }>;
  bills: Array<{ vendorName: string; dueDate: string; amount: string | null }>;
  moreBills: number;
  reviewCount: number;
}

const UP = '#15803d';
const DOWN = '#b91c1c';

function moveColor(direction: 'up' | 'down' | 'flat', brand: EmailBrand): string {
  if (direction === 'up') return UP;
  if (direction === 'down') return DOWN;
  return brand.textMuted;
}

function changeSentence(change: WeeklyDigestContent['change']): string | null {
  if (!change) return null;
  if (change.direction === 'flat') return 'Unchanged since last week.';
  return `${change.amount}${change.percent ? ` (${change.percent})` : ''} since last week.`;
}

/**
 * The weekly digest (SC-460) — the one message that reaches an account without
 * needing anyone to open the app first.
 *
 * The unsubscribe link is in the FOOTER OVERRIDE rather than appended to the
 * body, so it survives every future edit to the content above it, and it is a
 * plain `<a>` to a GET endpoint that needs no session. An unsubscribe that
 * asks the reader to sign in is not an unsubscribe.
 */
export function renderWeeklyDigestEmail({
  brand,
  name,
  digest,
  unsubscribeUrl,
  appUrl,
}: {
  brand: EmailBrand;
  name: string;
  digest: WeeklyDigestContent;
  unsubscribeUrl: string;
  appUrl: string;
}): EmailContent {
  const change = changeSentence(digest.change);
  const greeting = name.trim().split(/\s+/)[0] || 'there';

  const textLines = [
    `Hi ${greeting},`,
    ``,
    `Net worth: ${digest.netWorth} (as of ${digest.asOf})`,
    ...(change ? [change] : []),
  ];

  if (digest.movers.length > 0) {
    textLines.push(``, `Biggest movers`);
    for (const m of digest.movers) {
      textLines.push(`  • ${m.symbol}: ${m.amount}${m.percent ? ` (${m.percent})` : ''}`);
    }
  }

  if (digest.bills.length > 0) {
    textLines.push(``, `Due in the next 7 days`);
    for (const b of digest.bills) {
      textLines.push(`  • ${b.vendorName} — ${b.amount ?? 'amount not set'}, ${b.dueDate}`);
    }
    if (digest.moreBills > 0) {
      textLines.push(`  • and ${digest.moreBills} more`);
    }
  }

  if (digest.reviewCount > 0) {
    textLines.push(
      ``,
      `${digest.reviewCount} transfer${digest.reviewCount === 1 ? '' : 's'} waiting in your review queue.`
    );
  }

  textLines.push(``, `Open ${brand.appName}: ${appUrl}`, ``, `Unsubscribe: ${unsubscribeUrl}`);

  const section = (title: string, body: string): string => `
    <p style="margin:24px 0 8px 0;font-size:13px;font-weight:600;color:${brand.textPrimary};text-transform:uppercase;letter-spacing:0.06em;">
      ${escapeHtml(title)}
    </p>
    ${body}`;

  const moversHtml =
    digest.movers.length === 0
      ? ''
      : section(
          'Biggest movers',
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:14px;line-height:22px;">
      ${digest.movers
        .map(
          (m) => `<tr>
        <td style="padding:4px 0;color:${brand.textPrimary};font-weight:500;">${escapeHtml(m.symbol)}</td>
        <td align="right" style="padding:4px 0;color:${moveColor(m.direction, brand)};">
          ${escapeHtml(m.amount)}${m.percent ? ` <span style="color:${brand.textMuted};">${escapeHtml(m.percent)}</span>` : ''}
        </td>
      </tr>`
        )
        .join('')}
    </table>`
        );

  const billsHtml =
    digest.bills.length === 0
      ? ''
      : section(
          'Due in the next 7 days',
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:14px;line-height:22px;">
      ${digest.bills
        .map(
          (b) => `<tr>
        <td style="padding:4px 0;color:${brand.textPrimary};">${escapeHtml(b.vendorName)}
          <span style="color:${brand.textMuted};">· ${escapeHtml(b.dueDate)}</span>
        </td>
        <td align="right" style="padding:4px 0;color:${brand.textPrimary};">${escapeHtml(
          b.amount ?? '—'
        )}</td>
      </tr>`
        )
        .join('')}
      ${
        digest.moreBills > 0
          ? `<tr><td colspan="2" style="padding:4px 0;color:${brand.textMuted};">and ${digest.moreBills} more</td></tr>`
          : ''
      }
    </table>`
        );

  const reviewHtml =
    digest.reviewCount === 0
      ? ''
      : `<p style="margin:24px 0 0 0;font-size:14px;line-height:22px;color:${brand.textMuted};">
      <strong style="color:${brand.textPrimary};">${digest.reviewCount}</strong>
      transfer${digest.reviewCount === 1 ? '' : 's'} ${digest.reviewCount === 1 ? 'is' : 'are'}
      waiting in your review queue — until they are answered, gains on them are not booked.
    </p>`;

  const content = `
    <p style="margin:0 0 4px 0;font-size:13px;color:${brand.textMuted};">
      Your week, ${escapeHtml(greeting)}
    </p>
    <h1 style="margin:0;font-size:30px;line-height:36px;font-weight:600;letter-spacing:-0.02em;color:${brand.textPrimary};">
      ${escapeHtml(digest.netWorth)}
    </h1>
    <p style="margin:6px 0 0 0;font-size:14px;line-height:20px;color:${moveColor(
      digest.change?.direction ?? 'flat',
      brand
    )};">
      ${change ? escapeHtml(change) : 'No comparable figure from last week yet.'}
    </p>
    <p style="margin:2px 0 0 0;font-size:12px;color:${brand.textMuted};">
      As of ${escapeHtml(digest.asOf)}
    </p>
    ${moversHtml}
    ${billsHtml}
    ${reviewHtml}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 0 0;">
      <tr>
        <td style="border-radius:10px;background:${brand.accent};">
          <a href="${escapeHtml(appUrl)}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:${brand.accentText};text-decoration:none;border-radius:10px;">
            Open ${escapeHtml(brand.appName)}
          </a>
        </td>
      </tr>
    </table>
  `;

  return {
    subject: `${brand.appName}: ${digest.netWorth}${digest.change?.percent ? ` (${digest.change.percent} this week)` : ''}`,
    text: textLines.join('\n'),
    html: layout({
      brand,
      preheader: change
        ? `${digest.netWorth} — ${change}`
        : `${digest.netWorth} as of ${digest.asOf}`,
      content,
      footerNote: `You get this weekly because you have a portfolio in
                <a href="${escapeHtml(appUrl)}" style="color:${brand.textMuted};">${escapeHtml(brand.appName)}</a>.
                <a href="${escapeHtml(unsubscribeUrl)}" style="color:${brand.textMuted};text-decoration:underline;">Unsubscribe</a>
                — one click, no sign-in.`,
    }),
  };
}

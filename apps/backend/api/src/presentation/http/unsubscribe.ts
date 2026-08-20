import { EMAIL_STREAMS, type EmailStream, UserRepository } from '@scani/domain/repositories';
import { createComponentLogger } from '@scani/logging';
import { Container } from 'typedi';

const logger = createComponentLogger('http:unsubscribe');

// `email_unsubscribe_token` is a uuid column. Postgres raises on a malformed
// uuid comparison rather than returning no rows, so the shape is checked here
// and a junk token becomes a 404 page instead of a 500.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What each stream's success page says, and where it sends a reader who wanted
 * ALL of it stopped (SC-459).
 *
 * The cross-link is the whole reason the copy is per-stream rather than one
 * generic sentence. The streams opt out separately — muting a weekly summary is
 * not consent to be shown silently wrong figures — but somebody who clicks
 * "unsubscribe" usually means everything, and finding out a week later that it
 * only covered half is how a sender gets marked as spam instead. One more
 * click, on the page they are already looking at, with the same token.
 */
const STREAMS: Record<EmailStream, { stopped: string; other: { label: string; path: string } }> = {
  [EMAIL_STREAMS.digest]: {
    stopped: 'You will not get the weekly Scani digest again.',
    other: { label: 'stop those too', path: 'e/a' },
  },
  [EMAIL_STREAMS.alerts]: {
    stopped: 'You will not get alerts about your connections again.',
    other: { label: 'stop that too', path: 'e/u' },
  },
};

const OTHER_NAME: Record<EmailStream, string> = {
  [EMAIL_STREAMS.digest]: 'Alerts about a connection that stops syncing still arrive',
  [EMAIL_STREAMS.alerts]: 'The weekly digest still arrives',
};

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
  </head>
  <body style="margin:0;padding:48px 16px;background:#f5f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
    <div style="max-width:420px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:28px 32px;">
      <h1 style="margin:0 0 12px 0;font-size:20px;line-height:26px;font-weight:600;">${title}</h1>
      <p style="margin:0;font-size:15px;line-height:22px;color:#64748b;">${body}</p>
    </div>
  </body>
</html>`;
}

const html = (status: number, body: string): Response =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });

/**
 * One-click, no-login opt-out of one mail stream (SC-460, extended by SC-459).
 *
 * On the API rather than the data-provider, which is where the other two
 * `/e/*` email endpoints live, because this one WRITES to `users` — a table
 * the data-provider has no connection to. Same URL shape on purpose so they
 * read as one family.
 *
 * **One token, two streams.** The token names the ACCOUNT; which stream a link
 * stops is this endpoint's business. A second token column would have been a
 * second bearer credential to rotate, minted for each new kind of mail, and the
 * cross-link below would have been impossible.
 *
 * **GET, and it acts.** A confirmation step is the correct instinct for a
 * destructive verb and the wrong one here: an unsubscribe that does not take
 * effect on the first click is the failure mode this exists to prevent, and
 * the worst a prefetching mail client can do is stop mail the reader can turn
 * back on inside the app. Repeat clicks are idempotent — the first opt-out
 * keeps its date.
 */
export async function handleUnsubscribe(stream: EmailStream, token: string): Promise<Response> {
  if (!UUID.test(token)) {
    return html(404, page('Link not recognised', 'Check the link in your email, or open Scani.'));
  }
  try {
    const honoured = await Container.get(UserRepository).optOutByToken(stream, token);
    if (!honoured) {
      return html(404, page('Link not recognised', 'Check the link in your email, or open Scani.'));
    }
    const copy = STREAMS[stream];
    return html(
      200,
      page(
        'Unsubscribed',
        // No re-subscribe control exists yet, so the page does not offer one.
        // "Turn it back on in your account" would be the friendlier sentence
        // and would send the reader looking for a setting that is not there.
        `${copy.stopped} ${OTHER_NAME[stream]} — <a href="/${copy.other.path}/${token}">${copy.other.label}</a>. ` +
          'If this was a mistake, email support@scani.xyz and it will be turned back on.'
      )
    );
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error), stream },
      'Failed to honour an unsubscribe'
    );
    return html(
      500,
      page(
        "That didn't work",
        'Try the link again in a minute. If it keeps failing, reply to the email and it will be handled by hand.'
      )
    );
  }
}

// biome-ignore lint/suspicious/noExplicitAny: Elysia accumulates route types; match whatever shape the caller has.
export function registerUnsubscribeRoutes(app: any): void {
  app.get('/e/u/:token', ({ params }: { params: { token: string } }) =>
    handleUnsubscribe(EMAIL_STREAMS.digest, params.token)
  );
  app.get('/e/a/:token', ({ params }: { params: { token: string } }) =>
    handleUnsubscribe(EMAIL_STREAMS.alerts, params.token)
  );
}

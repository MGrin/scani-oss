import { authLogger } from '@scani/core/utils/logger';

/**
 * Minimal Fastmail JMAP email sender.
 *
 * Fastmail's SMTP server requires an app-specific password (separate UI
 * credential). JMAP accepts API tokens with the `mail/send` scope directly
 * — which is what the user already gave us as FASTMAIL_API_TOKEN, so we
 * avoid asking for a second secret by sending via JMAP instead of SMTP.
 *
 * This is intentionally not a full nodemailer transport — just the two
 * calls Better-Auth needs: Email/set to stage the message, then
 * EmailSubmission/set to hand it off to Fastmail's outbound queue.
 *
 * For Tier 1 / OSS self-hosters, this module isn't used; they set
 * SMTP_URL and nodemailer takes over. Scani's managed deployment
 * (Tier 3) sets FASTMAIL_API_TOKEN instead.
 */
export interface FastmailSender {
  sendMail(input: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<void>;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 10_000
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(new Error(`Fastmail fetch timeout after ${timeoutMs}ms`)),
    timeoutMs
  );
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parses an RFC 5322-ish address — accepts `"Name" <email@host>` or plain
 * `email@host` — into the two parts we care about. Returns the raw string
 * as the email if there's no `<…>` wrapper.
 */
function parseAddress(raw: string): { name?: string; email: string } {
  const match = raw.match(/^\s*(?:"?([^"<]*?)"?\s+)?<([^>]+)>\s*$/);
  if (match?.[2]) {
    return { name: match[1]?.trim() || undefined, email: match[2].trim() };
  }
  return { email: raw.trim() };
}

/**
 * Picks the Fastmail identity that authorizes sending as `fromEmail`.
 * Fastmail accepts both exact-match identities (`nikita@scani.xyz`) and
 * wildcard ones (`*@scani.xyz`). Falls back to the first identity.
 */
function pickIdentity(
  identities: Array<{ id: string; email: string }>,
  fromEmail: string
): { id: string; email: string } {
  const lower = fromEmail.toLowerCase();
  const exact = identities.find((i) => i.email.toLowerCase() === lower);
  if (exact) return exact;
  const domain = lower.split('@')[1];
  const wildcard = identities.find((i) => i.email.toLowerCase() === `*@${domain}`);
  if (wildcard) return wildcard;
  const first = identities[0];
  if (!first) throw new Error('No Fastmail identities available');
  return first;
}

export function createFastmailSender(apiToken: string): FastmailSender {
  const sessionUrl = 'https://api.fastmail.com/jmap/session';
  const authHeader = { Authorization: `Bearer ${apiToken}` };

  type SessionInfo = {
    apiUrl: string;
    accountId: string;
    identities: Array<{ id: string; email: string }>;
  };

  let cached: Promise<SessionInfo> | null = null;
  const getSession = (): Promise<SessionInfo> => {
    if (cached) return cached;
    cached = (async () => {
      const sessionRes = await fetchWithTimeout(sessionUrl, { headers: authHeader });
      if (!sessionRes.ok) {
        throw new Error(`JMAP session fetch failed: ${sessionRes.status}`);
      }
      const session = (await sessionRes.json()) as {
        apiUrl: string;
        primaryAccounts: Record<string, string>;
        username: string;
      };
      const apiUrl = session.apiUrl;
      const accountId = session.primaryAccounts['urn:ietf:params:jmap:submission'];
      if (!accountId) throw new Error('JMAP session has no submission account');

      const identitiesRes = await fetchWithTimeout(apiUrl, {
        method: 'POST',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:submission'],
          methodCalls: [['Identity/get', { accountId }, 'i0']],
        }),
      });
      if (!identitiesRes.ok) {
        throw new Error(`Identity/get failed: ${identitiesRes.status}`);
      }
      const identitiesJson = (await identitiesRes.json()) as {
        methodResponses: Array<[string, { list: Array<{ id: string; email: string }> }, string]>;
      };
      const identities = identitiesJson.methodResponses[0]?.[1]?.list ?? [];
      if (identities.length === 0) throw new Error('No Fastmail identities available');
      return { apiUrl, accountId, identities };
    })();
    return cached;
  };

  return {
    async sendMail(input) {
      const session = await getSession();
      const parsed = parseAddress(input.from);
      const identity = pickIdentity(session.identities, parsed.email);

      const body = {
        using: [
          'urn:ietf:params:jmap:core',
          'urn:ietf:params:jmap:mail',
          'urn:ietf:params:jmap:submission',
        ],
        methodCalls: [
          [
            'Email/set',
            {
              accountId: session.accountId,
              create: {
                e1: {
                  from: [{ email: parsed.email, ...(parsed.name ? { name: parsed.name } : {}) }],
                  to: [{ email: input.to }],
                  subject: input.subject,
                  keywords: { $seen: true, $draft: true },
                  mailboxIds: { [await getDraftsMailboxId(session, authHeader)]: true },
                  bodyValues: {
                    body: { value: input.text, charset: 'utf-8' },
                    ...(input.html ? { htmlBody: { value: input.html, charset: 'utf-8' } } : {}),
                  },
                  textBody: [{ partId: 'body', type: 'text/plain' }],
                  ...(input.html ? { htmlBody: [{ partId: 'htmlBody', type: 'text/html' }] } : {}),
                },
              },
            },
            'e1',
          ],
          [
            'EmailSubmission/set',
            {
              accountId: session.accountId,
              create: {
                s1: {
                  identityId: identity.id,
                  emailId: '#e1',
                },
              },
              onSuccessDestroyEmail: ['#s1'],
            },
            's1',
          ],
        ],
      };

      const res = await fetchWithTimeout(session.apiUrl, {
        method: 'POST',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errText = await res.text();
        authLogger.error({ status: res.status, body: errText.slice(0, 500) }, 'JMAP send failed');
        throw new Error(`JMAP send failed: ${res.status}`);
      }
      const json = (await res.json()) as {
        methodResponses: Array<[string, Record<string, unknown>, string]>;
      };
      const emailSetErrors = json.methodResponses[0]?.[1]?.notCreated as unknown as
        | Record<string, unknown>
        | undefined;
      const submissionErrors = json.methodResponses[1]?.[1]?.notCreated as unknown as
        | Record<string, unknown>
        | undefined;
      if (emailSetErrors && Object.keys(emailSetErrors).length > 0) {
        throw new Error(`JMAP Email/set errors: ${JSON.stringify(emailSetErrors)}`);
      }
      if (submissionErrors && Object.keys(submissionErrors).length > 0) {
        throw new Error(`JMAP EmailSubmission errors: ${JSON.stringify(submissionErrors)}`);
      }
    },
  };
}

let draftsMailboxIdCache: Promise<string> | null = null;

async function getDraftsMailboxId(
  session: { apiUrl: string; accountId: string },
  authHeader: { Authorization: string }
): Promise<string> {
  if (draftsMailboxIdCache) return draftsMailboxIdCache;
  const promise: Promise<string> = (async () => {
    const res = await fetchWithTimeout(session.apiUrl, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
        methodCalls: [
          ['Mailbox/query', { accountId: session.accountId, filter: { role: 'drafts' } }, 'm0'],
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Mailbox/query failed: HTTP ${res.status} ${body.slice(0, 300)}`);
    }
    const text = await res.text();
    let json: { methodResponses: Array<[string, { ids: string[] }, string]> };
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Mailbox/query returned non-JSON: ${text.slice(0, 300)}`);
    }
    const ids = json.methodResponses[0]?.[1]?.ids ?? [];
    const first = ids[0];
    if (!first) throw new Error('No Drafts mailbox found in Fastmail account');
    return first;
  })();
  draftsMailboxIdCache = promise;
  return promise;
}

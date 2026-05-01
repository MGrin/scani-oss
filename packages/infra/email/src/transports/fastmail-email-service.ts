import { createComponentLogger } from '@scani/logging';
import { EmailService } from '../email-service';
import type { EmailMessage } from '../types';

const log = createComponentLogger('email:fastmail');

interface FastmailSession {
  apiUrl: string;
  accountId: string;
  identities: Array<{ id: string; email: string }>;
}

// Fastmail JMAP rather than SMTP because the API token already in
// FASTMAIL_API_TOKEN carries `mail/send` scope; SMTP would require a
// separate app-specific password.
export class FastmailEmailService extends EmailService {
  private readonly authHeader: { Authorization: string };
  private session: Promise<FastmailSession> | null = null;
  private draftsMailboxId: Promise<string> | null = null;

  constructor(private readonly opts: { apiToken: string; fetcher?: typeof fetch }) {
    super();
    this.authHeader = { Authorization: `Bearer ${opts.apiToken}` };
  }

  protected async sendMessage(input: EmailMessage): Promise<void> {
    const session = await this.getSession();
    const parsed = parseAddress(input.from);
    const identity = pickIdentity(session.identities, parsed.email);
    const draftsMailboxId = await this.getDraftsMailboxId(session);

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
                mailboxIds: { [draftsMailboxId]: true },
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

    const res = await this.fetchWithTimeout(session.apiUrl, {
      method: 'POST',
      headers: { ...this.authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text();
      log.error({ status: res.status, body: errText.slice(0, 500) }, 'JMAP send failed');
      throw new Error(`JMAP send failed: ${res.status}`);
    }
    const json = (await res.json()) as {
      methodResponses: Array<[string, Record<string, unknown>, string]>;
    };
    const emailSetErrors = json.methodResponses[0]?.[1]?.notCreated as
      | Record<string, unknown>
      | undefined;
    const submissionErrors = json.methodResponses[1]?.[1]?.notCreated as
      | Record<string, unknown>
      | undefined;
    if (emailSetErrors && Object.keys(emailSetErrors).length > 0) {
      throw new Error(`JMAP Email/set errors: ${JSON.stringify(emailSetErrors)}`);
    }
    if (submissionErrors && Object.keys(submissionErrors).length > 0) {
      throw new Error(`JMAP EmailSubmission errors: ${JSON.stringify(submissionErrors)}`);
    }
  }

  private getSession(): Promise<FastmailSession> {
    if (this.session) return this.session;
    this.session = (async () => {
      const sessionRes = await this.fetchWithTimeout('https://api.fastmail.com/jmap/session', {
        headers: this.authHeader,
      });
      if (!sessionRes.ok) {
        throw new Error(`JMAP session fetch failed: ${sessionRes.status}`);
      }
      const session = (await sessionRes.json()) as {
        apiUrl: string;
        primaryAccounts: Record<string, string>;
      };
      const apiUrl = session.apiUrl;
      const accountId = session.primaryAccounts['urn:ietf:params:jmap:submission'];
      if (!accountId) throw new Error('JMAP session has no submission account');

      const identitiesRes = await this.fetchWithTimeout(apiUrl, {
        method: 'POST',
        headers: { ...this.authHeader, 'Content-Type': 'application/json' },
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
    return this.session;
  }

  private getDraftsMailboxId(session: FastmailSession): Promise<string> {
    if (this.draftsMailboxId) return this.draftsMailboxId;
    this.draftsMailboxId = (async () => {
      const res = await this.fetchWithTimeout(session.apiUrl, {
        method: 'POST',
        headers: { ...this.authHeader, 'Content-Type': 'application/json' },
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
    return this.draftsMailboxId;
  }

  private async fetchWithTimeout(
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
      const fetcher = this.opts.fetcher ?? fetch;
      return await fetcher(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

// Accepts `"Name" <email@host>` or plain `email@host`.
function parseAddress(raw: string): { name?: string; email: string } {
  const match = raw.match(/^\s*(?:"?([^"<]*?)"?\s+)?<([^>]+)>\s*$/);
  if (match?.[2]) {
    return { name: match[1]?.trim() || undefined, email: match[2].trim() };
  }
  return { email: raw.trim() };
}

// Fastmail accepts both exact-match identities (`nikita@scani.xyz`) and
// wildcard ones (`*@scani.xyz`). Falls back to the first identity.
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

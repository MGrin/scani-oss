const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8026';

export interface MailpitMessage {
  ID: string;
  From: { Address: string };
  To: { Address: string }[];
  Subject: string;
  Created: string;
}

export interface MailpitMessageBody {
  ID: string;
  Subject: string;
  Text: string;
  HTML: string;
}

export class MailpitClient {
  /**
   * Poll Mailpit for a message addressed to `recipient`. Returns the
   * first match. Throws after `timeoutMs` if none found.
   *
   * The `to:<address>` query filters server-side so concurrent tests
   * don't paginate through each other's mail.
   */
  async waitForMessageTo(
    recipient: string,
    opts: { timeoutMs?: number } = {}
  ): Promise<MailpitMessage> {
    const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
    const query = `to:${recipient}`;
    while (Date.now() < deadline) {
      const res = await fetch(
        `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(query)}&limit=1`
      );
      if (res.ok) {
        const json = (await res.json()) as { messages?: MailpitMessage[] };
        if (json.messages && json.messages.length > 0) {
          const msg = json.messages[0];
          if (msg) return msg;
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`No message to ${recipient} arrived within ${opts.timeoutMs ?? 10_000}ms`);
  }

  async getBody(messageId: string): Promise<MailpitMessageBody> {
    const res = await fetch(`${MAILPIT_URL}/api/v1/message/${messageId}`);
    if (!res.ok) throw new Error(`Failed to fetch message ${messageId}: ${res.status}`);
    return (await res.json()) as MailpitMessageBody;
  }

  /**
   * Extract a 6-digit OTP from a sign-in email's subject. The format
   * Scani's auth template uses is "123456 — your sign-in code · Scani"
   * (the leading 6-digit run is the OTP).
   */
  extractOtpFromSubject(subject: string): string {
    const match = subject.match(/\b(\d{6})\b/);
    if (!match?.[1]) throw new Error(`No 6-digit OTP found in subject: ${subject}`);
    return match[1];
  }

  /**
   * Extract a magic-link URL from a message body (HTML or Text). The
   * link is the first URL pointing at the Better-Auth magic-link verify
   * endpoint.
   */
  extractMagicLinkFromBody(body: MailpitMessageBody): string {
    const haystack = body.HTML || body.Text || '';
    const match = haystack.match(/https?:\/\/[^\s"'<>]+\/api\/auth\/magic-link\/verify[^\s"'<>]+/);
    if (!match) throw new Error('No magic-link URL found in email body');
    return match[0];
  }
}

export const mailpit = new MailpitClient();

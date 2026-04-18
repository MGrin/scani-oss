import { getEnv } from '../env';
import { type Result, tryCatch } from '../result';

const SESSION_URL = 'https://api.fastmail.com/jmap/session';

export interface FastmailStatus {
  tokenConfigured: boolean;
  username: string | null;
  accountName: string | null;
  capabilities: string[];
}

export async function getFastmailStatus(): Promise<Result<FastmailStatus>> {
  return tryCatch(async () => {
    const token = getEnv('FASTMAIL_API_TOKEN');
    if (!token) {
      return {
        tokenConfigured: false,
        username: null,
        accountName: null,
        capabilities: [],
      };
    }
    const res = await fetch(SESSION_URL, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`Fastmail session ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as {
      username: string;
      primaryAccounts?: Record<string, string>;
      accounts?: Record<string, { name: string }>;
      capabilities?: Record<string, unknown>;
    };

    const primaryMailAccountId = json.primaryAccounts?.['urn:ietf:params:jmap:mail'];
    const accountName = primaryMailAccountId
      ? (json.accounts?.[primaryMailAccountId]?.name ?? null)
      : null;

    return {
      tokenConfigured: true,
      username: json.username,
      accountName,
      capabilities: Object.keys(json.capabilities ?? {}),
    };
  });
}

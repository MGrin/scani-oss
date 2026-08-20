import { describe, expect, test } from 'bun:test';
import { EmailFacade } from '@scani/cloud-client/facades/email-facade';
import { Container } from 'typedi';
import { AlertDeliveryRepository } from '../../src/repositories/AlertDeliveryRepository';
import { InstitutionRepository } from '../../src/repositories/InstitutionRepository';
import { UserRepository } from '../../src/repositories/UserRepository';
import {
  INTEGRATION_STALE_RULE,
  SendIntegrationAlertsUseCase,
} from '../../src/use-cases/SendIntegrationAlertsUseCase';
import { restoreContainerAfterAll } from '../../test/helpers/container';

restoreContainerAfterAll();

const NOW = new Date('2026-08-19T09:00:00.000Z');
const OPTIONS = {
  appUrl: 'https://app.scani.xyz',
  unsubscribeBaseUrl: 'https://api.scani.xyz',
  staleAfterHours: 24,
};

const target = (over: Record<string, unknown> = {}) => ({
  credentialId: 'cred-1',
  userId: 'user-1',
  institutionId: 'inst-1',
  institutionName: 'Kraken',
  kind: 'stale-account' as const,
  ...over,
});

const recipient = (over: Record<string, unknown> = {}) => ({
  id: 'user-1',
  email: 'alice@example.com',
  name: 'Alice',
  unsubscribeToken: '8b1f1a2e-0000-4000-8000-000000000000',
  ...over,
});

interface Harness {
  sent: Array<{ to: string; subject: string; text: string; html: string }>;
  claimed: Array<{ userId: string; dedupeKey: string }>;
  markedSent: string[];
  released: string[];
  resolvedWith: Array<{ userId: string; dedupeKey: string }> | null;
  cutoff: Date | null;
  recipientQuery: string[] | null;
}

function makeUseCase(opts: {
  targets?: Array<ReturnType<typeof target>>;
  recipients?: Array<ReturnType<typeof recipient>>;
  /** Keys the ledger says are already delivered — claim refuses these. */
  alreadyOpen?: string[];
  sendThrows?: boolean;
  /** Fail the send for exactly this address, and only this one. */
  sendThrowsFor?: string;
}): { useCase: SendIntegrationAlertsUseCase; harness: Harness } {
  const harness: Harness = {
    sent: [],
    claimed: [],
    markedSent: [],
    released: [],
    resolvedWith: null,
    cutoff: null,
    recipientQuery: null,
  };
  const open = new Set(opts.alreadyOpen ?? []);

  Container.set(InstitutionRepository, {
    findStaleSyncTargets: async (cutoff: Date) => {
      harness.cutoff = cutoff;
      return opts.targets ?? [];
    },
  });
  Container.set(UserRepository, {
    findAlertRecipients: async (userIds: string[]) => {
      harness.recipientQuery = userIds;
      return opts.recipients ?? [];
    },
  });
  Container.set(AlertDeliveryRepository, {
    claim: async (_rule: string, candidates: Array<{ userId: string; dedupeKey: string }>) => {
      const granted = candidates.filter((c) => !open.has(c.dedupeKey));
      harness.claimed.push(...granted);
      return granted.map((c) => ({ ...c, id: `claim-${c.userId}-${c.dedupeKey}` }));
    },
    markSent: async (ids: string[]) => {
      harness.markedSent.push(...ids);
    },
    release: async (ids: string[]) => {
      harness.released.push(...ids);
    },
    resolve: async (_rule: string, keys: Array<{ userId: string; dedupeKey: string }>) => {
      harness.resolvedWith = keys;
      return 0;
    },
  });
  Container.set(EmailFacade, {
    sendBranded: async (input: {
      to: string;
      content: { subject: string; text: string; html: string };
    }) => {
      if (opts.sendThrows || opts.sendThrowsFor === input.to) throw new Error('smtp is down');
      harness.sent.push({
        to: input.to,
        subject: input.content.subject,
        text: input.content.text,
        html: input.content.html,
      });
    },
  });

  const useCase = new SendIntegrationAlertsUseCase();
  Container.set(SendIntegrationAlertsUseCase, useCase);
  return { useCase, harness };
}

describe('SendIntegrationAlertsUseCase (SC-459)', () => {
  test('a stale integration reaches its owner, with a reconnect link and both opt-outs', async () => {
    const { useCase, harness } = makeUseCase({
      targets: [target()],
      recipients: [recipient()],
    });

    const summary = await useCase.execute(OPTIONS, NOW);

    expect(summary.sent).toBe(1);
    expect(summary.claimed).toBe(1);
    const letter = harness.sent[0];
    expect(letter?.to).toBe('alice@example.com');
    expect(letter?.subject).toContain('Kraken');
    expect(letter?.html).toContain('https://app.scani.xyz/integrations');
    // Both streams' links, because the footer promises the reader that opting
    // out of alerts leaves the digest running and offers the other one.
    expect(letter?.html).toContain(
      'https://api.scani.xyz/e/a/8b1f1a2e-0000-4000-8000-000000000000'
    );
    expect(letter?.html).toContain(
      'https://api.scani.xyz/e/u/8b1f1a2e-0000-4000-8000-000000000000'
    );
  });

  test('the threshold is applied as a cutoff, not left to the caller', async () => {
    const { useCase, harness } = makeUseCase({});
    await useCase.execute({ ...OPTIONS, staleAfterHours: 24 }, NOW);
    expect(harness.cutoff?.toISOString()).toBe('2026-08-18T09:00:00.000Z');
  });

  test('an already-delivered alert is not repeated, and no letter is sent for it', async () => {
    // The single property the whole feature turns on.
    const { useCase, harness } = makeUseCase({
      targets: [target()],
      recipients: [recipient()],
      alreadyOpen: ['cred-1'],
    });

    const summary = await useCase.execute(OPTIONS, NOW);

    expect(summary.claimed).toBe(0);
    expect(summary.sent).toBe(0);
    expect(harness.sent).toEqual([]);
  });

  test('two integrations breaking for one account is one letter, not two', async () => {
    const { useCase, harness } = makeUseCase({
      targets: [
        target(),
        target({ credentialId: 'cred-2', institutionName: 'Wise', kind: 'orphaned-credential' }),
      ],
      recipients: [recipient()],
    });

    const summary = await useCase.execute(OPTIONS, NOW);

    expect(summary.sent).toBe(1);
    expect(summary.claimed).toBe(2);
    expect(harness.sent).toHaveLength(1);
    expect(harness.sent[0]?.text).toContain('Kraken');
    expect(harness.sent[0]?.text).toContain('Wise');
  });

  test('only the newly-claimed integrations are named, not everything still broken', async () => {
    const { useCase, harness } = makeUseCase({
      targets: [target(), target({ credentialId: 'cred-2', institutionName: 'Wise' })],
      recipients: [recipient()],
      alreadyOpen: ['cred-1'],
    });

    await useCase.execute(OPTIONS, NOW);

    expect(harness.sent[0]?.text).toContain('Wise');
    expect(harness.sent[0]?.text).not.toContain('Kraken');
  });

  test('an account that may not be mailed is never claimed for', async () => {
    // Claiming first and filtering after would burn the alert: the row would
    // suppress forever and the account would never be told, including after
    // they verify their address.
    const { useCase, harness } = makeUseCase({
      targets: [target()],
      recipients: [],
    });

    const summary = await useCase.execute(OPTIONS, NOW);

    expect(summary.affectedUsers).toBe(1);
    expect(summary.eligibleUsers).toBe(0);
    expect(harness.claimed).toEqual([]);
  });

  test('a failed send hands the claim back rather than burning it', async () => {
    const { useCase, harness } = makeUseCase({
      targets: [target()],
      recipients: [recipient()],
      sendThrows: true,
    });

    const summary = await useCase.execute(OPTIONS, NOW);

    expect(summary.failed).toBe(1);
    expect(summary.sent).toBe(0);
    expect(harness.released).toEqual(['claim-user-1-cred-1']);
    expect(harness.markedSent).toEqual([]);
  });

  test('the ledger is only marked sent AFTER the transport accepts', async () => {
    const { useCase, harness } = makeUseCase({
      targets: [target()],
      recipients: [recipient()],
    });
    await useCase.execute(OPTIONS, NOW);
    expect(harness.markedSent).toEqual(['claim-user-1-cred-1']);
  });

  test('one account failing does not stop the next', async () => {
    const { useCase, harness } = makeUseCase({
      targets: [target(), target({ userId: 'user-2', credentialId: 'cred-2' })],
      recipients: [recipient(), recipient({ id: 'user-2', email: 'bob@example.com' })],
      sendThrowsFor: 'alice@example.com',
    });

    const summary = await useCase.execute(OPTIONS, NOW);

    expect(summary.failed).toBe(1);
    expect(summary.sent).toBe(1);
    expect(harness.sent.map((s) => s.to)).toEqual(['bob@example.com']);
  });

  test('resolution runs over the whole rule, including accounts nobody mailed', async () => {
    // An opted-out account still holds old open rows. If they never clear, a
    // later break finds them present and says nothing.
    const { useCase, harness } = makeUseCase({
      targets: [target(), target({ userId: 'opted-out', credentialId: 'cred-9' })],
      recipients: [recipient()],
    });

    await useCase.execute(OPTIONS, NOW);

    expect(harness.resolvedWith).toEqual([
      { userId: 'user-1', dedupeKey: 'cred-1' },
      { userId: 'opted-out', dedupeKey: 'cred-9' },
    ]);
  });

  test('a healthy userbase resolves everything and sends nothing', async () => {
    const { useCase, harness } = makeUseCase({ targets: [] });

    const summary = await useCase.execute(OPTIONS, NOW);

    expect(summary.stale).toBe(0);
    expect(harness.sent).toEqual([]);
    // An empty active set is a legitimate state, not a reason to skip resolve —
    // otherwise the last open alert never clears.
    expect(harness.resolvedWith).toEqual([]);
  });

  test('missing public URLs refuse loudly instead of mailing a broken link', async () => {
    const { useCase, harness } = makeUseCase({
      targets: [target()],
      recipients: [recipient()],
    });

    const summary = await useCase.execute({ ...OPTIONS, unsubscribeBaseUrl: '' }, NOW);

    expect(summary.unconfigured).toBe(true);
    expect(harness.sent).toEqual([]);
    // Nothing is claimed either — a claim burnt here would suppress the alert
    // forever once the URL is configured.
    expect(harness.claimed).toEqual([]);
    expect(harness.resolvedWith).toBeNull();
  });

  test('the rule string is the one written into the ledger', async () => {
    // Renaming it orphans every open alert and re-notifies the whole userbase.
    expect(INTEGRATION_STALE_RULE).toBe('integration-stale');
  });
});

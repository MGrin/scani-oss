import { describe, expect, test } from 'bun:test';
import { EmailFacade } from '@scani/cloud-client/facades/email-facade';
import { Container } from 'typedi';
import { UserRepository } from '../../src/repositories/UserRepository';
import { WeeklyDigestService } from '../../src/services/digest/WeeklyDigestService';
import {
  DIGEST_COOLDOWN_MS,
  SendWeeklyDigestsUseCase,
} from '../../src/use-cases/SendWeeklyDigestsUseCase';
import { restoreContainerAfterAll } from '../../test/helpers/container';

restoreContainerAfterAll();

const NOW = new Date('2026-08-19T09:00:00.000Z');
const OPTIONS = {
  appUrl: 'https://app.scani.xyz',
  unsubscribeBaseUrl: 'https://api.scani.xyz',
};

const recipient = (over: Record<string, unknown> = {}) => ({
  id: 'user-1',
  email: 'alice@example.com',
  name: 'Alice',
  baseCurrencyId: 'usd-token',
  unsubscribeToken: '8b1f1a2e-0000-4000-8000-000000000000',
  ...over,
});

const digest = {
  netWorth: '$1,000.00',
  asOf: '2026-08-18',
  change: null,
  movers: [],
  bills: [],
  moreBills: 0,
  reviewCount: 0,
};

interface Harness {
  sent: Array<{ to: string; subject: string; html: string }>;
  markedSent: string[];
  cooldownArg: Date | null;
}

function makeUseCase(opts: {
  recipients?: Array<ReturnType<typeof recipient>>;
  outcome?: unknown;
  sendThrows?: boolean;
}): { useCase: SendWeeklyDigestsUseCase; harness: Harness } {
  const harness: Harness = { sent: [], markedSent: [], cooldownArg: null };

  Container.set(UserRepository, {
    findDigestRecipients: async (cooldownBefore: Date) => {
      harness.cooldownArg = cooldownBefore;
      return opts.recipients ?? [];
    },
    markDigestSent: async (userId: string) => {
      harness.markedSent.push(userId);
    },
  });
  Container.set(WeeklyDigestService, {
    buildFor: async () => opts.outcome ?? { digest },
  });
  Container.set(EmailFacade, {
    sendBranded: async (input: { to: string; content: { subject: string; html: string } }) => {
      if (opts.sendThrows) throw new Error('smtp is down');
      harness.sent.push({
        to: input.to,
        subject: input.content.subject,
        html: input.content.html,
      });
    },
  });

  const useCase = new SendWeeklyDigestsUseCase();
  Container.set(SendWeeklyDigestsUseCase, useCase);
  return { useCase, harness };
}

describe('SendWeeklyDigestsUseCase', () => {
  test('refuses, loudly, when the public URLs are not configured', async () => {
    // "0 sent" over a missing URL reads identically to "0 sent" over an idle
    // userbase. The flag is what tells an operator which one happened.
    const { useCase, harness } = makeUseCase({ recipients: [recipient()] });
    const summary = await useCase.execute({ appUrl: '', unsubscribeBaseUrl: '' }, NOW);

    expect(summary.unconfigured).toBe(true);
    expect(summary.sent).toBe(0);
    expect(harness.sent).toHaveLength(0);
  });

  test('sends one digest and records it AFTER the send resolves', async () => {
    const { useCase, harness } = makeUseCase({ recipients: [recipient()] });
    const summary = await useCase.execute(OPTIONS, NOW);

    expect(summary.sent).toBe(1);
    expect(harness.sent[0]?.to).toBe('alice@example.com');
    expect(harness.sent[0]?.subject).toContain('Scani');
    expect(harness.markedSent).toEqual(['user-1']);
  });

  test('a transport failure does not record a send, so the retry can happen', async () => {
    const { useCase, harness } = makeUseCase({ recipients: [recipient()], sendThrows: true });
    const summary = await useCase.execute(OPTIONS, NOW);

    expect(summary.failed).toBe(1);
    expect(summary.sent).toBe(0);
    expect(harness.markedSent).toEqual([]);
  });

  test('one failing recipient does not stop the rest', async () => {
    const { useCase } = makeUseCase({
      recipients: [recipient(), recipient({ id: 'user-2', email: 'bob@example.com' })],
      sendThrows: true,
    });
    const summary = await useCase.execute(OPTIONS, NOW);
    expect(summary.failed).toBe(2);
    expect(summary.candidates).toBe(2);
  });

  test('the unsubscribe URL is built from the token, on the api host', async () => {
    const { useCase, harness } = makeUseCase({ recipients: [recipient()] });
    await useCase.execute(OPTIONS, NOW);
    expect(harness.sent[0]?.html).toContain(
      'https://api.scani.xyz/e/u/8b1f1a2e-0000-4000-8000-000000000000'
    );
  });

  test('a trailing slash on the api host does not produce a double slash', async () => {
    const { useCase, harness } = makeUseCase({ recipients: [recipient()] });
    await useCase.execute({ ...OPTIONS, unsubscribeBaseUrl: 'https://api.scani.xyz/' }, NOW);
    expect(harness.sent[0]?.html).toContain('https://api.scani.xyz/e/u/');
    expect(harness.sent[0]?.html).not.toContain('scani.xyz//e/u/');
  });

  test('asks the repository for accounts not mailed inside the cooldown', async () => {
    // The advisory lock stops two overlapping fires; it does nothing about a
    // BullMQ retry of a run that already mailed half the userbase.
    const { useCase, harness } = makeUseCase({});
    await useCase.execute(OPTIONS, NOW);
    expect(harness.cooldownArg?.toISOString()).toBe(
      new Date(NOW.getTime() - DIGEST_COOLDOWN_MS).toISOString()
    );
  });

  test('each skip reason is counted separately and nothing is mailed', async () => {
    for (const [reason, field] of [
      ['no-snapshot', 'skippedNoSnapshot'],
      ['stale-snapshot', 'skippedStaleSnapshot'],
      ['no-holdings', 'skippedNoHoldings'],
    ] as const) {
      const { useCase, harness } = makeUseCase({
        recipients: [recipient()],
        outcome: { skipped: reason },
      });
      const summary = await useCase.execute(OPTIONS, NOW);
      expect(summary[field]).toBe(1);
      expect(summary.sent).toBe(0);
      expect(harness.sent).toHaveLength(0);
    }
  });
});

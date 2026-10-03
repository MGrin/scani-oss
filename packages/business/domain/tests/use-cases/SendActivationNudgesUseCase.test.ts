import { describe, expect, test } from 'bun:test';
import { EmailFacade } from '@scani/cloud-client/facades/email-facade';
import { Container } from 'typedi';
import { UserRepository } from '../../src/repositories/UserRepository';
import {
  ACTIVATION_NUDGE_DELAY_MS,
  SendActivationNudgesUseCase,
} from '../../src/use-cases/SendActivationNudgesUseCase';
import { restoreContainerAfterAll } from '../../test/helpers/container';

restoreContainerAfterAll();

const NOW = new Date('2026-10-02T10:00:00.000Z');
const OPTIONS = {
  appUrl: 'https://app.scani.xyz',
  unsubscribeBaseUrl: 'https://api.scani.xyz/',
  privacyUrl: 'https://scani.xyz/privacy',
};

const recipient = (over: Record<string, unknown> = {}) => ({
  id: 'user-1',
  email: 'alice@example.com',
  name: 'Alice Example',
  language: null as string | null,
  unsubscribeToken: '8b1f1a2e-0000-4000-8000-000000000000',
  ...over,
});

/**
 * An in-memory `activation_nudge_sent_at` with the same semantics as the SQL:
 * claim sets it only when NULL, release clears it only when it still holds the
 * releaser's own instant.
 */
function makeUseCase(opts: {
  recipients?: Array<ReturnType<typeof recipient>>;
  sendThrows?: boolean;
  preClaimed?: string[];
}) {
  const sentAt = new Map<string, Date>();
  for (const id of opts.preClaimed ?? []) sentAt.set(id, new Date(0));
  const harness = {
    sent: [] as Array<{ to: string; subject: string; html: string }>,
    signedUpBefore: null as Date | null,
    sentAt,
  };
  Container.set(UserRepository, {
    findActivationNudgeRecipients: async (signedUpBefore: Date) => {
      harness.signedUpBefore = signedUpBefore;
      return opts.recipients ?? [];
    },
    claimActivationNudge: async (userId: string, at: Date) => {
      if (sentAt.has(userId)) return false;
      sentAt.set(userId, at);
      return true;
    },
    releaseActivationNudge: async (userId: string, at: Date) => {
      if (sentAt.get(userId) === at) sentAt.delete(userId);
    },
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
  const useCase = new SendActivationNudgesUseCase();
  Container.set(SendActivationNudgesUseCase, useCase);
  return { useCase, harness };
}

describe('SendActivationNudgesUseCase (SC-1503)', () => {
  test('asks only for accounts that signed up at least three days ago', async () => {
    const { useCase, harness } = makeUseCase({});
    await useCase.execute(OPTIONS, NOW);
    expect(harness.signedUpBefore?.getTime()).toBe(NOW.getTime() - ACTIVATION_NUDGE_DELAY_MS);
  });

  test('sends one letter per candidate and records the send', async () => {
    const { useCase, harness } = makeUseCase({ recipients: [recipient()] });
    const summary = await useCase.execute(OPTIONS, NOW);

    expect(summary).toMatchObject({ candidates: 1, sent: 1, failed: 0, alreadyClaimed: 0 });
    expect(harness.sent.map((m) => m.to)).toEqual(['alice@example.com']);
    expect(harness.sentAt.get('user-1')).toEqual(NOW);
  });

  test('never twice: a second run over the same account sends nothing', async () => {
    const { useCase, harness } = makeUseCase({ recipients: [recipient()] });
    await useCase.execute(OPTIONS, NOW);
    const second = await useCase.execute(OPTIONS, NOW);

    expect(second).toMatchObject({ sent: 0, alreadyClaimed: 1 });
    expect(harness.sent).toHaveLength(1);
  });

  test('never silently zero: a failed send is counted and its claim given back', async () => {
    const { useCase, harness } = makeUseCase({ recipients: [recipient()], sendThrows: true });
    const summary = await useCase.execute(OPTIONS, NOW);

    expect(summary).toMatchObject({ candidates: 1, sent: 0, failed: 1 });
    // Released, so tomorrow's run can claim it again.
    expect(harness.sentAt.has('user-1')).toBe(false);
  });

  test("a release never clears somebody else's claim", async () => {
    const { useCase, harness } = makeUseCase({
      recipients: [recipient()],
      sendThrows: true,
      preClaimed: ['user-1'],
    });
    const summary = await useCase.execute(OPTIONS, NOW);

    expect(summary).toMatchObject({ alreadyClaimed: 1, failed: 0 });
    expect(harness.sentAt.get('user-1')).toEqual(new Date(0));
  });

  test('the unsubscribe link names the onboarding stream and the account token', async () => {
    const { useCase, harness } = makeUseCase({ recipients: [recipient()] });
    await useCase.execute(OPTIONS, NOW);
    expect(harness.sent[0]?.html).toContain(
      'https://api.scani.xyz/e/n/8b1f1a2e-0000-4000-8000-000000000000'
    );
    expect(harness.sent[0]?.html).toContain('https://scani.xyz/privacy');
  });

  test('writes in the account language, and in English when none is recorded', async () => {
    const { useCase, harness } = makeUseCase({
      recipients: [
        recipient(),
        recipient({ id: 'user-2', email: 'b@example.com', language: 'ru' }),
      ],
    });
    await useCase.execute(OPTIONS, NOW);
    expect(harness.sent.map((m) => m.subject)).toEqual([
      'Add your first account to Scani',
      'Добавьте первый счёт в Scani',
    ]);
  });

  test('a missing URL is a refusal, not an empty run', async () => {
    const { useCase, harness } = makeUseCase({ recipients: [recipient()] });
    const summary = await useCase.execute({ ...OPTIONS, privacyUrl: '' }, NOW);

    expect(summary).toMatchObject({ unconfigured: true, candidates: 0, sent: 0 });
    expect(harness.sent).toEqual([]);
  });
});

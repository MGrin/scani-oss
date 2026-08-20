import { beforeEach, describe, expect, test } from 'bun:test';
import type { PushPayload, PushSendResult, PushTarget } from '@scani/push';
import { PushSender } from '@scani/push';
import { Container } from 'typedi';
import { PaymentOccurrenceRepository } from '../../src/repositories/PaymentOccurrenceRepository';
import { PushSubscriptionRepository } from '../../src/repositories/PushSubscriptionRepository';
import { SendPaymentDueRemindersUseCase } from '../../src/use-cases/SendPaymentDueRemindersUseCase';
import { restoreContainerAfterAll } from '../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

/**
 * The reminder's fan-out, with the transport and the database stubbed.
 *
 * The cases here are the ones where a plausible implementation is silently
 * wrong: a user in a zone where it is not yet 17:00, a subscribed user with no
 * timezone at all, a night with nothing due, a retry, and a push service
 * saying a subscription is gone. Each of those produces "0 notified", and only
 * the counters tell them apart.
 */

const BALI = 'Asia/Makassar'; // UTC+8, no DST.
const LONDON = 'Europe/London'; // UTC+1 in August.

/** 09:00 UTC = 17:00 in Bali, 10:00 in London. */
const AT_1700_BALI = new Date('2026-08-16T09:00:00.000Z');

interface Device {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  lastSentAt: Date | null;
}

class StubSubscriptions {
  candidates: { userId: string; timezone: string | null }[] = [];
  devices: Device[] = [];
  markedSent: { ids: string[]; at: Date }[] = [];
  deleted: string[] = [];

  async findReminderCandidates() {
    return this.candidates;
  }
  async findByUser(userId: string) {
    return this.devices.filter((d) => d.userId === userId);
  }
  async markSent(ids: string[], at: Date) {
    if (ids.length > 0) this.markedSent.push({ ids, at });
  }
  async deleteByIds(ids: string[]) {
    this.deleted.push(...ids);
    this.devices = this.devices.filter((d) => !ids.includes(d.id));
    return ids.length;
  }
}

class StubOccurrences {
  byUserAndDate = new Map<string, unknown[]>();
  queried: { userId: string; dueDate: string }[] = [];

  async findDueOnDateForUser(userId: string, dueDate: string) {
    this.queried.push({ userId, dueDate });
    return (this.byUserAndDate.get(`${userId}|${dueDate}`) ?? []) as never[];
  }
}

class StubSender {
  configured = true;
  results = new Map<string, PushSendResult>();
  sends: { target: PushTarget; payload: PushPayload }[] = [];

  isConfigured() {
    return this.configured;
  }
  publicKey() {
    return this.configured ? 'key' : null;
  }
  async send(target: PushTarget, payload: PushPayload): Promise<PushSendResult> {
    this.sends.push({ target, payload });
    return this.results.get(target.endpoint) ?? { status: 'sent' };
  }
}

function occurrence(id: string, dueDate: string, amount: string | null, symbol = '$') {
  return {
    occurrenceId: id,
    dueDate,
    expectedAmount: amount,
    currencyTokenId: 'token-1',
    currencySymbol: symbol,
  };
}

function device(id: string, userId: string, lastSentAt: Date | null = null): Device {
  return { id, userId, endpoint: `https://push.example/${id}`, p256dh: 'p', auth: 'a', lastSentAt };
}

let subscriptions: StubSubscriptions;
let occurrences: StubOccurrences;
let sender: StubSender;

function makeUseCase(): SendPaymentDueRemindersUseCase {
  subscriptions = new StubSubscriptions();
  occurrences = new StubOccurrences();
  sender = new StubSender();
  // Class-field DI: seed the container, THEN construct, so the field
  // initialisers read the stubs. Never `Container.reset()` — it wipes the
  // `@Service()` registration.
  Container.set(PushSubscriptionRepository, subscriptions);
  Container.set(PaymentOccurrenceRepository, occurrences);
  Container.set(PushSender, sender);
  return new SendPaymentDueRemindersUseCase();
}

beforeEach(() => {
  makeUseCase();
});

describe('SendPaymentDueRemindersUseCase', () => {
  test('sends one aggregated push at 17:00 local, not one per payment', async () => {
    const useCase = makeUseCase();
    subscriptions.candidates = [{ userId: 'u1', timezone: BALI }];
    subscriptions.devices = [device('d1', 'u1')];
    occurrences.byUserAndDate.set('u1|2026-08-17', [
      occurrence('o1', '2026-08-17', '100.00'),
      occurrence('o2', '2026-08-17', '150.50'),
      occurrence('o3', '2026-08-17', '249.50'),
    ]);

    const summary = await useCase.execute(AT_1700_BALI);

    expect(sender.sends).toHaveLength(1);
    expect(sender.sends[0]?.payload.body).toBe('3 payments due tomorrow · $500.00');
    expect(summary.notified).toBe(1);
    expect(summary.sent).toBe(1);
  });

  test('asks for the user`s LOCAL tomorrow, not UTC tomorrow', async () => {
    const useCase = makeUseCase();
    subscriptions.candidates = [{ userId: 'u1', timezone: BALI }];
    subscriptions.devices = [device('d1', 'u1')];

    await useCase.execute(AT_1700_BALI);

    // 2026-08-16T09:00Z is already the 16th in Bali, so tomorrow is the 17th.
    expect(occurrences.queried).toEqual([{ userId: 'u1', dueDate: '2026-08-17' }]);
  });

  test('a user whose local time is not 17:00 is not even queried', async () => {
    const useCase = makeUseCase();
    subscriptions.candidates = [{ userId: 'u1', timezone: LONDON }];
    subscriptions.devices = [device('d1', 'u1')];

    const summary = await useCase.execute(AT_1700_BALI);

    expect(occurrences.queried).toEqual([]);
    expect(sender.sends).toEqual([]);
    expect(summary.dueNow).toBe(0);
    expect(summary.candidates).toBe(1);
  });

  test('a subscribed user with NO timezone is skipped AND counted', async () => {
    // The number that separates "nothing was due" from "timezone capture is
    // broken and this feature is a no-op".
    const useCase = makeUseCase();
    subscriptions.candidates = [
      { userId: 'u1', timezone: null },
      { userId: 'u2', timezone: BALI },
    ];
    subscriptions.devices = [device('d1', 'u1'), device('d2', 'u2')];
    occurrences.byUserAndDate.set('u2|2026-08-17', [occurrence('o1', '2026-08-17', '10.00')]);

    const summary = await useCase.execute(AT_1700_BALI);

    expect(summary.missingTimezone).toBe(1);
    expect(summary.dueNow).toBe(1);
    expect(sender.sends).toHaveLength(1);
    expect(sender.sends[0]?.target.endpoint).toBe('https://push.example/d2');
  });

  test('nothing due means SILENCE, not a zero', async () => {
    const useCase = makeUseCase();
    subscriptions.candidates = [{ userId: 'u1', timezone: BALI }];
    subscriptions.devices = [device('d1', 'u1')];

    const summary = await useCase.execute(AT_1700_BALI);

    expect(sender.sends).toEqual([]);
    expect(summary.silent).toBe(1);
    expect(summary.notified).toBe(0);
  });

  test('every device of one user receives, and each is marked sent', async () => {
    const useCase = makeUseCase();
    subscriptions.candidates = [{ userId: 'u1', timezone: BALI }];
    subscriptions.devices = [device('d1', 'u1'), device('d2', 'u1')];
    occurrences.byUserAndDate.set('u1|2026-08-17', [occurrence('o1', '2026-08-17', '42.00')]);

    const summary = await useCase.execute(AT_1700_BALI);

    expect(sender.sends).toHaveLength(2);
    expect(summary.sent).toBe(2);
    expect(summary.notified).toBe(1);
    expect(subscriptions.markedSent[0]?.ids.sort()).toEqual(['d1', 'd2']);
  });

  test('a device already sent to inside the cooldown is suppressed', async () => {
    // The advisory lock stops two OVERLAPPING fires; it does not stop a retry
    // after a partial failure from pushing again to everyone it reached.
    const useCase = makeUseCase();
    subscriptions.candidates = [{ userId: 'u1', timezone: BALI }];
    subscriptions.devices = [
      device('d1', 'u1', new Date(AT_1700_BALI.getTime() - 60_000)),
      device('d2', 'u1'),
    ];
    occurrences.byUserAndDate.set('u1|2026-08-17', [occurrence('o1', '2026-08-17', '42.00')]);

    const summary = await useCase.execute(AT_1700_BALI);

    expect(sender.sends).toHaveLength(1);
    expect(sender.sends[0]?.target.endpoint).toBe('https://push.example/d2');
    expect(summary.suppressed).toBe(1);
  });

  test('a send from yesterday does NOT suppress today`s reminder', async () => {
    const useCase = makeUseCase();
    subscriptions.candidates = [{ userId: 'u1', timezone: BALI }];
    subscriptions.devices = [
      device('d1', 'u1', new Date(AT_1700_BALI.getTime() - 24 * 60 * 60 * 1000)),
    ];
    occurrences.byUserAndDate.set('u1|2026-08-17', [occurrence('o1', '2026-08-17', '42.00')]);

    const summary = await useCase.execute(AT_1700_BALI);

    expect(summary.sent).toBe(1);
    expect(summary.suppressed).toBe(0);
  });

  test('carries a per-day tag so a duplicate replaces rather than stacks', async () => {
    const useCase = makeUseCase();
    subscriptions.candidates = [{ userId: 'u1', timezone: BALI }];
    subscriptions.devices = [device('d1', 'u1')];
    occurrences.byUserAndDate.set('u1|2026-08-17', [occurrence('o1', '2026-08-17', '42.00')]);

    await useCase.execute(AT_1700_BALI);

    expect(sender.sends[0]?.payload.tag).toBe('payment-due-2026-08-17');
    expect(sender.sends[0]?.payload.url).toBe('/payments');
  });

  test('a gone subscription is deleted; a failure is kept', async () => {
    const useCase = makeUseCase();
    subscriptions.candidates = [{ userId: 'u1', timezone: BALI }];
    subscriptions.devices = [device('d1', 'u1'), device('d2', 'u1'), device('d3', 'u1')];
    occurrences.byUserAndDate.set('u1|2026-08-17', [occurrence('o1', '2026-08-17', '42.00')]);
    sender.results.set('https://push.example/d2', { status: 'gone' });
    // 403 is a VAPID mismatch — OUR key changed, not their subscription.
    sender.results.set('https://push.example/d3', {
      status: 'failed',
      statusCode: 403,
      reason: 'forbidden',
    });

    const summary = await useCase.execute(AT_1700_BALI);

    expect(subscriptions.deleted).toEqual(['d2']);
    expect(summary.pruned).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.sent).toBe(1);
  });

  test('with no VAPID keys it refuses by name and touches nothing', async () => {
    const useCase = makeUseCase();
    sender.configured = false;
    subscriptions.candidates = [{ userId: 'u1', timezone: BALI }];
    subscriptions.devices = [device('d1', 'u1')];

    const summary = await useCase.execute(AT_1700_BALI);

    expect(summary.unconfigured).toBe(true);
    expect(sender.sends).toEqual([]);
    expect(occurrences.queried).toEqual([]);
  });

  test('one user failing does not stop the others', async () => {
    const useCase = makeUseCase();
    subscriptions.candidates = [
      { userId: 'boom', timezone: BALI },
      { userId: 'u2', timezone: BALI },
    ];
    subscriptions.devices = [device('d2', 'u2')];
    occurrences.byUserAndDate.set('u2|2026-08-17', [occurrence('o1', '2026-08-17', '7.00')]);
    const original = occurrences.findDueOnDateForUser.bind(occurrences);
    occurrences.findDueOnDateForUser = async (userId: string, dueDate: string) => {
      if (userId === 'boom') throw new Error('database said no');
      return original(userId, dueDate);
    };

    const summary = await useCase.execute(AT_1700_BALI);

    expect(summary.sent).toBe(1);
    expect(summary.dueNow).toBe(2);
  });
});

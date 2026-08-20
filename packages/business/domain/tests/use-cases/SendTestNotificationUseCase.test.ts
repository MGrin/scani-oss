import { beforeEach, describe, expect, test } from 'bun:test';
import type { PushPayload, PushSendResult, PushTarget } from '@scani/push';
import { PushSender } from '@scani/push';
import { Container } from 'typedi';
import { PushSubscriptionRepository } from '../../src/repositories/PushSubscriptionRepository';
import { REMINDER_TARGET_PATH } from '../../src/use-cases/SendPaymentDueRemindersUseCase';
import { SendTestNotificationUseCase } from '../../src/use-cases/SendTestNotificationUseCase';
import { restoreContainerAfterAll } from '../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

/**
 * The test send exists to distinguish outcomes a boolean cannot (SC-322), so
 * every case here is a distinction: a dead subscription from a live one, our
 * own key mismatch from the device's problem, a deployment with no keys from a
 * user with no devices.
 */

interface Device {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  lastSentAt: Date | null;
}

class StubSubscriptions {
  devices: Device[] = [];
  markedSent: { ids: string[]; at: Date }[] = [];
  deleted: string[] = [];

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

function device(id: string, userId: string, userAgent: string | null = null): Device {
  return {
    id,
    userId,
    endpoint: `https://push.example/${id}`,
    p256dh: 'p',
    auth: 'a',
    userAgent,
    lastSentAt: null,
  };
}

let subscriptions: StubSubscriptions;
let sender: StubSender;

function makeUseCase(): SendTestNotificationUseCase {
  subscriptions = new StubSubscriptions();
  sender = new StubSender();
  Container.set(PushSubscriptionRepository, subscriptions);
  Container.set(PushSender, sender);
  return new SendTestNotificationUseCase();
}

beforeEach(() => {
  makeUseCase();
});

describe('SendTestNotificationUseCase', () => {
  test('sends once to every device the caller owns, and to nobody else`s', async () => {
    const useCase = makeUseCase();
    subscriptions.devices = [device('d1', 'u1'), device('d2', 'u1'), device('d3', 'u2')];

    const report = await useCase.execute('u1');

    expect(sender.sends.map((s) => s.target.endpoint)).toEqual([
      'https://push.example/d1',
      'https://push.example/d2',
    ]);
    expect(report.devices.map((d) => d.outcome.status)).toEqual(['sent', 'sent']);
  });

  test('lands on the same path the real reminder does', async () => {
    // A test notification that opens a different screen from the reminder is
    // not a test of the reminder.
    const useCase = makeUseCase();
    subscriptions.devices = [device('d1', 'u1')];

    await useCase.execute('u1');

    expect(sender.sends[0]?.payload.url).toBe(REMINDER_TARGET_PATH);
  });

  test('does NOT touch last_sent_at, so a test cannot suppress the real reminder', async () => {
    // `markSent` starts a 12-hour cooldown. Recording a test send inside it
    // would silence the reminder the user just checked was working.
    const useCase = makeUseCase();
    subscriptions.devices = [device('d1', 'u1')];

    await useCase.execute('u1');

    expect(subscriptions.markedSent).toEqual([]);
  });

  test('reports 410 as gone and prunes the row', async () => {
    const useCase = makeUseCase();
    subscriptions.devices = [device('d1', 'u1'), device('d2', 'u1')];
    sender.results.set('https://push.example/d1', { status: 'gone' });

    const report = await useCase.execute('u1');

    expect(report.devices.map((d) => d.outcome.status)).toEqual(['gone', 'sent']);
    expect(subscriptions.deleted).toEqual(['d1']);
    expect(report.pruned).toBe(1);
  });

  test('reports 403 as a VAPID mismatch, and keeps the subscription', async () => {
    // 403 is our own keypair, not the user's device. Pruning here would empty
    // the table on the first deploy that rotated the keys.
    const useCase = makeUseCase();
    subscriptions.devices = [device('d1', 'u1')];
    sender.results.set('https://push.example/d1', {
      status: 'failed',
      statusCode: 403,
      reason: 'Received unexpected response code',
    });

    const report = await useCase.execute('u1');

    expect(report.devices[0]?.outcome).toEqual({ status: 'vapid-mismatch' });
    expect(subscriptions.deleted).toEqual([]);
    expect(report.pruned).toBe(0);
  });

  test('any other failure keeps its status code, so the reader can name it', async () => {
    const useCase = makeUseCase();
    subscriptions.devices = [device('d1', 'u1')];
    sender.results.set('https://push.example/d1', {
      status: 'failed',
      statusCode: 429,
      reason: 'Too many requests',
    });

    const report = await useCase.execute('u1');

    expect(report.devices[0]?.outcome).toEqual({
      status: 'failed',
      statusCode: 429,
      reason: 'Too many requests',
    });
    expect(subscriptions.deleted).toEqual([]);
  });

  test('a transport failure with no status code is still a failure, not a mismatch', async () => {
    const useCase = makeUseCase();
    subscriptions.devices = [device('d1', 'u1')];
    sender.results.set('https://push.example/d1', {
      status: 'failed',
      reason: 'getaddrinfo ENOTFOUND',
    });

    const report = await useCase.execute('u1');

    expect(report.devices[0]?.outcome).toEqual({
      status: 'failed',
      statusCode: null,
      reason: 'getaddrinfo ENOTFOUND',
    });
  });

  test('a deployment with no VAPID keys refuses rather than reporting an empty result', async () => {
    const useCase = makeUseCase();
    sender.configured = false;
    subscriptions.devices = [device('d1', 'u1')];

    const report = await useCase.execute('u1');

    expect(report.configured).toBe(false);
    expect(report.devices).toEqual([]);
    expect(sender.sends).toEqual([]);
  });

  test('no devices is a configured server with nothing to send to', async () => {
    // Distinct from the refusal above: the caller renders a different sentence
    // for "we cannot send" than for "you have not subscribed anything".
    const useCase = makeUseCase();

    const report = await useCase.execute('u1');

    expect(report).toEqual({ configured: true, devices: [], pruned: 0 });
  });

  test('carries the device`s user agent back, so two devices can be told apart', async () => {
    const useCase = makeUseCase();
    subscriptions.devices = [device('d1', 'u1', 'iPhone'), device('d2', 'u1', null)];

    const report = await useCase.execute('u1');

    expect(report.devices.map((d) => ({ endpoint: d.endpoint, userAgent: d.userAgent }))).toEqual([
      { endpoint: 'https://push.example/d1', userAgent: 'iPhone' },
      { endpoint: 'https://push.example/d2', userAgent: null },
    ]);
  });
});

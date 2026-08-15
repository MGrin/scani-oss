import { describe, expect, test } from 'bun:test';
import { UserJobRepository } from '@scani/domain/repositories';
import type { LifecycleEvent } from '@scani/queue';
import Container from 'typedi';
import { UserJobLifecycleMirror } from '../../src/infrastructure/user-job-lifecycle-mirror';

/**
 * The mirror is the only thing that turns a queue event into something a user
 * can see. SC-153 added `dead` to it, and the distinction this suite protects
 * is the one the whole ticket is about: `failed` and `dead` are different
 * events with different writes, and routing `dead` to `markFailed` would put
 * the product back where it started.
 */

interface Call {
  method: string;
  args: unknown[];
}

function makeMirror(): { mirror: UserJobLifecycleMirror; calls: Call[] } {
  const calls: Call[] = [];
  const record =
    (method: string) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
    };
  Container.set(UserJobRepository, {
    markActive: record('markActive'),
    updateProgress: record('updateProgress'),
    markCompleted: record('markCompleted'),
    markFailed: record('markFailed'),
    markDead: record('markDead'),
  } as unknown as UserJobRepository);
  const mirror = new UserJobLifecycleMirror();
  Container.set(UserJobLifecycleMirror, mirror);
  return { mirror, calls };
}

const base = { jobId: 'job-1', userId: 'user-1', jobName: 'wallet-import' };

describe('UserJobLifecycleMirror', () => {
  test('a failed attempt writes a failure, not a death', async () => {
    const { mirror, calls } = makeMirror();
    await mirror.onLifecycle({
      ...base,
      type: 'failed',
      error: 'upstream 502',
      attemptsMade: 1,
      attemptsAllowed: 3,
    } satisfies LifecycleEvent);

    expect(calls.map((c) => c.method)).toEqual(['markFailed']);
  });

  test('a death writes a death, carrying its reason', async () => {
    const { mirror, calls } = makeMirror();
    await mirror.onLifecycle({
      ...base,
      type: 'dead',
      error: 'upstream 502',
      attemptsMade: 3,
      attemptsAllowed: 3,
      reason: 'retries_exhausted',
    } satisfies LifecycleEvent);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('markDead');
    expect(calls[0]?.args[0]).toBe('job-1');
    expect(calls[0]?.args[1]).toMatchObject({
      reason: 'retries_exhausted',
      error: 'upstream 502',
      attemptsMade: 3,
      attemptsAllowed: 3,
    });
  });

  test('an unrecoverable death keeps its own reason rather than being flattened', async () => {
    // The two reasons produce different sentences for the user — "we tried
    // three times" is false of a job whose remaining attempts were skipped by
    // design.
    const { mirror, calls } = makeMirror();
    await mirror.onLifecycle({
      ...base,
      type: 'dead',
      error: 'bad credentials',
      attemptsMade: 1,
      attemptsAllowed: 3,
      reason: 'unrecoverable',
    } satisfies LifecycleEvent);

    expect(calls[0]?.args[1]).toMatchObject({ reason: 'unrecoverable', attemptsMade: 1 });
  });

  test('the ordinary lifecycle still routes where it always did', async () => {
    const { mirror, calls } = makeMirror();
    await mirror.onLifecycle({ ...base, type: 'active', attemptsMade: 1 });
    await mirror.onLifecycle({ ...base, type: 'progress', progress: 0.5 });
    await mirror.onLifecycle({ ...base, type: 'completed', result: { ok: true } });

    expect(calls.map((c) => c.method)).toEqual(['markActive', 'updateProgress', 'markCompleted']);
  });
});

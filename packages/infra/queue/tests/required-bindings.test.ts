import { beforeEach, describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
// This workspace cannot depend on @scani/domain (it sits below it), so the
// shared helper is reached the same way the shared test preload is: by path.
import { restoreContainerAfterAll } from '../../../business/domain/test/helpers/container';
import { JOB_HEARTBEAT_WRITER } from '../src/consumer/job-heartbeat-writer';
import { JOB_LOCK } from '../src/consumer/job-lock';
import { LIFECYCLE_MIRROR } from '../src/consumer/lifecycle-mirror';
import { ENQUEUE_MIRROR } from '../src/producer/enqueue-mirror';
import {
  assertQueueBindings,
  isQueueBindingRegistered,
  type QueueBinding,
} from '../src/required-bindings';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

/**
 * SC-298. Four resolve sites in this package swallow a missing binding with
 * `catch { return null }`, and all four are correct: OSS Tier 1 and this test
 * suite legitimately have no mirror, no lock and no heartbeat writer.
 *
 * The same `null` also means nobody imported `@scani/jobs`, and on the managed
 * deployment that is invisible — every job runs with no `user_jobs` row, every
 * scheduled job runs with no advisory lock, and nothing is logged at any level.
 *
 * These tests hold both halves of the distinction:
 *
 *  - a deployment that DECLARES a requirement fails loudly when it is unmet;
 *  - a deployment that declares nothing behaves exactly as before, which is
 *    what keeps the OSS and test paths free.
 *
 * The tokens are removed before each test rather than assumed absent. `bun
 * test` can share a process across files, so "nothing registered it" is a
 * property of the run, not of the code — and a test that passes because of
 * what its neighbours did is the failure this repo keeps finding.
 */

const ALL: QueueBinding[] = ['enqueue-mirror', 'lifecycle-mirror', 'job-lock', 'heartbeat-writer'];

beforeEach(() => {
  // Safe here in a way `Container.reset()` would not be: these are `Token`s
  // whose concretes live in `@scani/jobs`, which this package does not import,
  // so there is no `@Service()` registration to destroy.
  Container.remove(ENQUEUE_MIRROR);
  Container.remove(LIFECYCLE_MIRROR);
  Container.remove(JOB_LOCK);
  Container.remove(JOB_HEARTBEAT_WRITER);
});

describe('assertQueueBindings', () => {
  test('throws when a declared binding is not registered', () => {
    expect(() => assertQueueBindings(['enqueue-mirror'])).toThrow(/enqueue-mirror/);
  });

  test('the message says what breaks, and how to fix it', () => {
    let message = '';
    try {
      assertQueueBindings(['enqueue-mirror']);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    // The consequence, not just the absence — "enqueue-mirror is missing"
    // tells a reader nothing about why they should care.
    expect(message).toContain('no `user_jobs` row is written');
    // The actual fix, named. This is the line whose deletion causes it.
    expect(message).toContain("import '@scani/jobs'");
    // And the way out for a deployment that genuinely has no mirror, so
    // nobody registers a stub to silence it.
    expect(message).toContain('do not call assertQueueBindings');
  });

  test('reports every missing binding at once, not the first', () => {
    let message = '';
    try {
      assertQueueBindings(ALL);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    // A deployment that lost the import is missing all four, and learning
    // them one boot at a time is four restarts to discover one fact.
    for (const binding of ALL) expect(message).toContain(binding);
  });

  test('passes once the bindings are registered', () => {
    Container.set(ENQUEUE_MIRROR, { onEnqueued: async () => {}, onEnqueueFailed: async () => {} });
    Container.set(LIFECYCLE_MIRROR, { onLifecycle: async () => {} });
    Container.set(JOB_LOCK, { withLock: async () => undefined });
    Container.set(JOB_HEARTBEAT_WRITER, { record: async () => {} });

    expect(() => assertQueueBindings(ALL)).not.toThrow();
  });

  test('declaring nothing is not an error — this is the OSS and test path', () => {
    // The load-bearing one. If this ever throws, the change has made the
    // deployments with no mirror harder to run in order to protect the one
    // that has it, which is the trade this design exists to avoid.
    expect(() => assertQueueBindings([])).not.toThrow();
  });
});

describe('isQueueBindingRegistered', () => {
  test('is false when absent and true once set', () => {
    expect(isQueueBindingRegistered('job-lock')).toBe(false);
    Container.set(JOB_LOCK, { withLock: async () => undefined });
    expect(isQueueBindingRegistered('job-lock')).toBe(true);
  });
});

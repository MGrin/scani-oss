import { beforeEach, describe, expect, test } from 'bun:test';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { SendActivationNudgesUseCase } from '@scani/domain/use-cases';
import { Container } from 'typedi';
import { ActivationNudgeProcessor } from '../../src/processors/activation-nudge';

restoreContainerAfterAll();

const env: {
  ACTIVATION_NUDGE_ENABLED?: '1' | '';
  FRONTEND_URL?: string;
  BACKEND_URL?: string;
  PRIVACY_URL?: string;
} = {};

class Exposed extends ActivationNudgeProcessor {
  protected override readEnv() {
    return env;
  }
  run(): Promise<void> {
    return this.handle();
  }
}

const calls: Array<Record<string, string>> = [];

beforeEach(() => {
  calls.length = 0;
  delete env.ACTIVATION_NUDGE_ENABLED;
  Object.assign(env, {
    FRONTEND_URL: 'https://app.scani.xyz',
    BACKEND_URL: 'https://api.scani.xyz',
    PRIVACY_URL: 'https://scani.xyz/privacy',
  });
  Container.set(SendActivationNudgesUseCase, {
    execute: async (options: Record<string, string>) => {
      calls.push(options);
      return { candidates: 0, sent: 0, failed: 0, alreadyClaimed: 0, unconfigured: false };
    },
  });
});

describe('ActivationNudgeProcessor ships switched off (SC-1503)', () => {
  test.each([undefined, '', '0', 'true'])(
    'ACTIVATION_NUDGE_ENABLED=%p sends nothing',
    async (value) => {
      // Only the literal `1` arms it; the schema would reject `0` and `true` at
      // boot, and the gate must hold even if one got through.
      env.ACTIVATION_NUDGE_ENABLED = value as '1' | '' | undefined;
      await new Exposed().run();
      expect(calls).toEqual([]);
    }
  );

  test('ACTIVATION_NUDGE_ENABLED=1 runs the sweep with the three public URLs', async () => {
    env.ACTIVATION_NUDGE_ENABLED = '1';
    await new Exposed().run();
    expect(calls).toEqual([
      {
        appUrl: 'https://app.scani.xyz',
        unsubscribeBaseUrl: 'https://api.scani.xyz',
        privacyUrl: 'https://scani.xyz/privacy',
      },
    ]);
  });

  test('a missing PRIVACY_URL reaches the use case as empty, which refuses', async () => {
    env.ACTIVATION_NUDGE_ENABLED = '1';
    delete env.PRIVACY_URL;
    await new Exposed().run();
    expect(calls[0]?.privacyUrl).toBe('');
  });
});

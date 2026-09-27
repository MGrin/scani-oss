import { afterEach, expect, test } from 'bun:test';
import { StorageService } from '@scani/storage';
import { Container } from 'typedi';
import { restoreContainerAfterAll } from '../../../business/domain/test/helpers/container';
import type { CloudClient } from '../src/client';
import { loadCloudClientConfig, resetCloudClientConfig } from '../src/config';
import { StorageFacade } from '../src/facades/storage-facade';
import { resetCloudClient, setCloudClient } from '../src/runtime';

restoreContainerAfterAll();
const originalTier = process.env.SCANI_DEPLOYMENT_TIER;
afterEach(() => {
  if (originalTier === undefined) delete process.env.SCANI_DEPLOYMENT_TIER;
  else process.env.SCANI_DEPLOYMENT_TIER = originalTier;
  resetCloudClientConfig();
  resetCloudClient();
});

test('Tier 2 requires cloud credentials even outside production', () => {
  resetCloudClientConfig();
  expect(() => loadCloudClientConfig({ NODE_ENV: 'test', SCANI_DEPLOYMENT_TIER: '2' })).toThrow();
});

test('invalid deployment tier refuses rather than selecting a fallback', () => {
  resetCloudClientConfig();
  expect(() =>
    loadCloudClientConfig({ NODE_ENV: 'test', SCANI_DEPLOYMENT_TIER: 'typo' })
  ).toThrow();
});

test('Tier 2 uses customer S3 even with a working cloud client', async () => {
  process.env.SCANI_DEPLOYMENT_TIER = '2';
  resetCloudClientConfig();
  loadCloudClientConfig({
    NODE_ENV: 'test',
    SCANI_DEPLOYMENT_TIER: '2',
    SCANI_CLOUD_URL: 'https://cloud.example',
    SCANI_CLOUD_API_KEY: 'test-cloud-key-123456',
  });
  const remote = {
    storage: {
      readTempBlob: {
        mutate: () => {
          throw new Error('Cloud storage was reached');
        },
      },
    },
  };
  setCloudClient(remote as unknown as CloudClient);
  Container.set(StorageService, {
    read: async () => Buffer.from('customer-owned'),
  } as unknown as StorageService);
  expect((await new StorageFacade().read('owned/document')).toString()).toBe('customer-owned');
});

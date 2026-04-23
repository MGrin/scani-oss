/**
 * Drop-in replacement for the call surface that backend + worker use from
 * `@scani/storage`. When SCANI_CLOUD_URL + SCANI_CLOUD_API_KEY are set we
 * route through the data-provider; otherwise we delegate to the legacy
 * in-process `@scani/storage` implementation.
 *
 * Keeping the selector in one place means call sites like
 * `import { readTempBlob } from '@scani/cloud-client/storage-facade'`
 * don't care about deployment mode. The OSS self-host config (no cloud
 * envs, local R2 credentials set on the backend) keeps working as a
 * zero-cost wrapper.
 *
 * Cloud-mode resolution is lazy and goes through {@link getCloudClient}
 * (./runtime) so tests can swap the client without re-importing the
 * module.
 */

import {
  deleteTempBlob as legacyDeleteTempBlob,
  presignDownload as legacyPresignDownload,
  presignUpload as legacyPresignUpload,
  readTempBlob as legacyReadTempBlob,
  type PresignedUpload,
} from '@scani/storage';
import { CloudStorage } from './adapters/storage';
import { getCloudClient } from './runtime';

let cloudStorage: CloudStorage | null | undefined;

function resolveCloudStorage(): CloudStorage | null {
  if (cloudStorage !== undefined) return cloudStorage;
  const client = getCloudClient();
  cloudStorage = client ? new CloudStorage({ client }) : null;
  return cloudStorage;
}

export async function presignUpload(options: {
  keyPrefix: string;
  extension: string;
  contentType: string;
  contentLength: number;
  ttlSeconds?: number;
}): Promise<PresignedUpload> {
  const facade = resolveCloudStorage();
  if (facade) return facade.presignUpload(options);
  return legacyPresignUpload(options);
}

export async function presignDownload(key: string, ttlSeconds?: number): Promise<string> {
  const facade = resolveCloudStorage();
  if (facade) return facade.presignDownload(key, ttlSeconds);
  return legacyPresignDownload(key, ttlSeconds);
}

export async function readTempBlob(key: string): Promise<Buffer> {
  const facade = resolveCloudStorage();
  if (facade) return facade.readTempBlob(key);
  return legacyReadTempBlob(key);
}

export async function deleteTempBlob(key: string): Promise<void> {
  const facade = resolveCloudStorage();
  if (facade) return facade.deleteTempBlob(key);
  return legacyDeleteTempBlob(key);
}

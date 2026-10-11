import {
  type PresignedUpload,
  type PresignUploadOptions,
  type ReadOptions,
  StorageService,
} from '@scani/storage';
import { Container, Service } from 'typedi';
import { CloudStorage } from '../cloud-services/cloud-storage';
import { loadCloudClientConfig } from '../config';
import { getCloudClient } from '../runtime';

// Re-exported here rather than made a direct `@scani/storage` dependency of
// every consumer: callers reach object storage through this facade, so the
// predicate that classifies its errors belongs on the same boundary.
export { isMissingObjectError, isObjectTooLargeError } from '@scani/storage';

const TEMP_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

// Self-hosted tiers always use customer S3. Legacy/managed deployments retain
// their internal cloud storage transport independently of provider routing.
@Service()
export class StorageFacade {
  // undefined = haven't checked; null = checked and no cloud client.
  private cachedCloud: CloudStorage | null | undefined;

  presignUpload(options: PresignUploadOptions): Promise<PresignedUpload> {
    const cloud = this.cloud();
    if (cloud) return cloud.presignUpload(options);
    return Promise.resolve(this.local().presignUpload(options));
  }

  presignDownload(key: string, ttlSeconds?: number): Promise<string> {
    const cloud = this.cloud();
    if (cloud) return cloud.presignDownload(key, ttlSeconds);
    return Promise.resolve(this.local().presignDownload(key, ttlSeconds));
  }

  exists(key: string): Promise<boolean> {
    const cloud = this.cloud();
    if (cloud) return cloud.exists(key);
    return this.local().exists(key);
  }

  read(key: string, opts?: Pick<ReadOptions, 'maxBytes'>): Promise<Buffer> {
    const cloud = this.cloud();
    if (cloud) return cloud.read(key, opts);
    return this.local().read(key, opts);
  }

  readObject(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    const cloud = this.cloud();
    if (cloud) return cloud.readObject(key);
    return this.local().readObject(key);
  }

  write(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const cloud = this.cloud();
    if (cloud) return cloud.write(key, bytes, contentType);
    return this.local().write(key, bytes, contentType);
  }

  /**
   * Write bytes a server process produced under a fresh `temp/<prefix>/<uuid>.<ext>`
   * key and return the key (SC-1649). Through the cloud it is a presigned PUT
   * straight to the bucket, because `write` carries base64 over tRPC and the
   * data-provider refuses more than 256 KB outside `documents/`.
   */
  async writeTemp(
    opts: { keyPrefix: string; extension: string; contentType: string },
    bytes: Uint8Array<ArrayBuffer>
  ): Promise<string> {
    const cloud = this.cloud();
    if (!cloud) return this.local().writeTemp(opts, bytes);
    const upload = await cloud.presignUpload({ ...opts, contentLength: bytes.byteLength });
    const response = await fetch(upload.uploadUrl, {
      method: 'PUT',
      headers: upload.requiredHeaders,
      body: bytes,
      signal: AbortSignal.timeout(TEMP_UPLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `StorageFacade.writeTemp: the upload was refused with HTTP ${response.status}`
      );
    }
    return upload.key;
  }

  copy(fromKey: string, toKey: string, contentType?: string): Promise<void> {
    const cloud = this.cloud();
    if (cloud) return cloud.copy(fromKey, toKey, contentType);
    return this.local().copy(fromKey, toKey, contentType);
  }

  delete(key: string): Promise<void> {
    const cloud = this.cloud();
    if (cloud) return cloud.delete(key);
    return this.local().delete(key);
  }

  private cloud(): CloudStorage | null {
    if (this.cachedCloud !== undefined) return this.cachedCloud;
    const tier = loadCloudClientConfig().SCANI_DEPLOYMENT_TIER;
    if (tier === '1' || tier === '2') {
      this.cachedCloud = null;
      return null;
    }
    const client = getCloudClient();
    this.cachedCloud = client ? new CloudStorage(client) : null;
    return this.cachedCloud;
  }

  private local(): StorageService {
    return Container.get(StorageService);
  }
}

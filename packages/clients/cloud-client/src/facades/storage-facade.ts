import { type PresignedUpload, type PresignUploadOptions, StorageService } from '@scani/storage';
import { Container, Service } from 'typedi';
import { CloudStorage } from '../cloud-services/cloud-storage';
import { getCloudClient } from '../runtime';

// Re-exported here rather than made a direct `@scani/storage` dependency of
// every consumer: callers reach object storage through this facade, so the
// predicate that classifies its errors belongs on the same boundary.
export { isMissingObjectError } from '@scani/storage';

// Cloud-or-local dispatcher resolved via typedi. When SCANI_CLOUD_URL is set
// the call routes through the data-provider; otherwise it falls through to
// the in-process StorageService.
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

  read(key: string): Promise<Buffer> {
    const cloud = this.cloud();
    if (cloud) return cloud.read(key);
    return this.local().read(key);
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
    const client = getCloudClient();
    this.cachedCloud = client ? new CloudStorage(client) : null;
    return this.cachedCloud;
  }

  private local(): StorageService {
    return Container.get(StorageService);
  }
}

import type { CloudClient } from '../index';
import { CloudError } from '../index';

/**
 * Mirror of `@scani/storage`'s public surface, but every call bounces
 * through the data-provider. Keeps `presignUpload` / `readTempBlob` /
 * `deleteTempBlob` semantics identical so call-site diffs in
 * backend/worker are one-liners.
 *
 * Note: the presigned URL is still an R2/MinIO URL bound to the
 * data-provider's bucket credentials; the browser PUTs to R2 directly.
 * We don't proxy the blob bytes — that's the whole point of presigning.
 */

export interface CloudPresignedUpload {
  uploadUrl: string;
  key: string;
  expiresAt: string;
  requiredHeaders: Record<string, string>;
}

export class CloudStorage {
  private readonly client: CloudClient;

  constructor(opts: { client: CloudClient }) {
    this.client = opts.client;
  }

  async presignUpload(options: {
    keyPrefix: string;
    extension: string;
    contentType: string;
    contentLength: number;
    ttlSeconds?: number;
  }): Promise<CloudPresignedUpload> {
    try {
      return (await this.client.storage.presignUpload.mutate(options)) as CloudPresignedUpload;
    } catch (err) {
      throw CloudError.wrap(err);
    }
  }

  async presignDownload(key: string, ttlSeconds?: number): Promise<string> {
    try {
      const { url } = await this.client.storage.presignDownload.query({
        key,
        ttlSeconds,
      });
      return url;
    } catch (err) {
      throw CloudError.wrap(err);
    }
  }

  async readTempBlob(key: string): Promise<Buffer> {
    try {
      const { base64 } = await this.client.storage.readTempBlob.mutate({ key });
      return Buffer.from(base64, 'base64');
    } catch (err) {
      throw CloudError.wrap(err);
    }
  }

  async deleteTempBlob(key: string): Promise<void> {
    try {
      await this.client.storage.deleteTempBlob.mutate({ key });
    } catch (err) {
      // `@scani/storage`'s local variant swallows 404s (lifecycle rule
      // may have already deleted); preserve that behavior in cloud mode
      // to not crash background sweeps.
      const cloudErr = CloudError.wrap(err);
      if (/NoSuchKey|404|not found/i.test(String(cloudErr.message))) return;
      throw cloudErr;
    }
  }
}

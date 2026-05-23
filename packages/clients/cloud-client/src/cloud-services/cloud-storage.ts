import type { PresignedUpload, PresignUploadOptions } from '@scani/storage';
import type { CloudClient } from '../client';
import { CloudError } from '../errors';

export class CloudStorage {
  constructor(private readonly client: CloudClient) {}

  async presignUpload(options: PresignUploadOptions): Promise<PresignedUpload> {
    try {
      return (await this.client.storage.presignUpload.mutate(options)) as PresignedUpload;
    } catch (err) {
      throw CloudError.wrap(err);
    }
  }

  async presignDownload(key: string, ttlSeconds?: number): Promise<string> {
    try {
      const { url } = await this.client.storage.presignDownload.query({ key, ttlSeconds });
      return url;
    } catch (err) {
      throw CloudError.wrap(err);
    }
  }

  async read(key: string): Promise<Buffer> {
    try {
      const { base64 } = await this.client.storage.readTempBlob.mutate({ key });
      return Buffer.from(base64, 'base64');
    } catch (err) {
      throw CloudError.wrap(err);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.storage.deleteTempBlob.mutate({ key });
    } catch (err) {
      // Match @scani/storage's local-side behaviour: lifecycle rules can race
      // a sweep and delete the blob first. Treat 404 as success.
      const cloudErr = CloudError.wrap(err);
      if (/NoSuchKey|404|not found/i.test(String(cloudErr.message))) return;
      throw cloudErr;
    }
  }
}

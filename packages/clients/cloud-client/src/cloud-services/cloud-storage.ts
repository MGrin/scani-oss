import {
  isMissingObjectError,
  type PresignedUpload,
  type PresignUploadOptions,
} from '@scani/storage';
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

  async exists(key: string): Promise<boolean> {
    try {
      const { exists } = await this.client.storage.objectExists.mutate({ key });
      return exists;
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

  async readObject(key: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    try {
      const result = await this.client.storage.readObject.mutate({ key });
      if (!result.found) return null;
      return {
        bytes: new Uint8Array(Buffer.from(result.base64, 'base64')),
        contentType: result.contentType,
      };
    } catch (err) {
      throw CloudError.wrap(err);
    }
  }

  async write(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    try {
      await this.client.storage.writeObject.mutate({
        key,
        base64: Buffer.from(bytes).toString('base64'),
        contentType,
      });
    } catch (err) {
      throw CloudError.wrap(err);
    }
  }

  async copy(fromKey: string, toKey: string, contentType?: string): Promise<void> {
    try {
      await this.client.storage.copyObject.mutate({ fromKey, toKey, contentType });
    } catch (err) {
      throw CloudError.wrap(err);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.storage.deleteTempBlob.mutate({ key });
    } catch (err) {
      // Match @scani/storage's local-side behaviour: a concurrent delete or
      // a lifecycle sweep can remove the blob first. Already gone is success.
      const cloudErr = CloudError.wrap(err);
      if (isMissingObjectError(cloudErr)) return;
      throw cloudErr;
    }
  }
}

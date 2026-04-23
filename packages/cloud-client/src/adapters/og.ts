import type { CloudClient } from '../index';
import { CloudError } from '../index';

/**
 * Thin wrapper over the data-provider OG endpoint. The backend keeps its
 * per-user rate limit + in-memory cache — those need authenticated
 * userId and session state that this client doesn't have — and calls
 * through to here for the actual network hop.
 */

export interface CloudOGMetadata {
  title: string;
  description: string;
  siteName: string;
  image: string;
  type: string;
  finalUrl: string;
  truncated: boolean;
}

export function createCloudOGClient(client: CloudClient) {
  return {
    async fetchMetadata(url: string): Promise<CloudOGMetadata> {
      try {
        return (await client.og.fetchMetadata.query({ url })) as CloudOGMetadata;
      } catch (err) {
        throw CloudError.wrap(err);
      }
    },
  };
}

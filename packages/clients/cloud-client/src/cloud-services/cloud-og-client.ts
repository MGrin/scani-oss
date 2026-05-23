import type { CloudClient } from '../client';
import { CloudError } from '../errors';

export interface CloudOGMetadata {
  title: string;
  description: string;
  siteName: string;
  image: string;
  type: string;
  finalUrl: string;
  truncated: boolean;
}

// OG fetch lives only on the data-provider — there's no local fallback to
// dispatch against, so this is a plain client (no facade companion).
// The backend layers per-user rate-limit + in-memory cache around it,
// which need session state this module doesn't have.
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

import { FailureExplainer } from '@scani/queue';
import { providerErrorIn } from './provider-error';

/**
 * The owner's reason for a failure a provider caused and no processor marked
 * (SC-1711). The sentence names the provider and is written here; the
 * provider's own text stays on the operator's row (SC-551).
 */
export class ProviderFailureExplainer extends FailureExplainer {
  explain(error: unknown): string | null {
    const provider = providerErrorIn(error);
    if (!provider) return null;
    const source = provider.providerKey
      ? `The ${provider.providerKey.charAt(0).toUpperCase()}${provider.providerKey.slice(1)} data source`
      : 'A data source';
    switch (provider.kind) {
      case 'rate-limited':
        return `${source} is limiting how often Scani may ask it, so this stopped. Try again later.`;
      case 'auth-failed':
        return `${source} rejected the saved credentials. Reconnect the account, then try again.`;
      case 'retryable':
        return `${source} did not answer properly, so this stopped. Try again later.`;
      default:
        return null;
    }
  }
}

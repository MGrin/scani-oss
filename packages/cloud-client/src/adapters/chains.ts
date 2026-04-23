import type { IBlockchainService, TokenBalance } from '@scani/integrations/blockchain-services';
import type { CloudClient } from '../index';
import { CloudError } from '../index';

/**
 * Drop-in replacement for the backend-side chain services. Sync methods
 * (`isValidAddress`, `getChainId`, `getChainName`) delegate to an inner
 * real chain service instance so the regex/name metadata stays on the
 * caller side (zero-RTT). Async methods that hit the network
 * (`getTokenBalances`, `hasActivity`, `resolveAddressName`) go to the
 * data-provider.
 *
 * Why a hybrid instead of pure-RPC: `IntegrationManager.detectWalletChains`
 * checks `isValidAddress` for every chain before doing anything — making
 * those calls remote would turn a single wallet import into ~30 round
 * trips. Keeping address validation local also means the OSS user can
 * ship a tiny no-op data-provider and still validate addresses offline.
 */
export class CloudChainService implements IBlockchainService {
  private readonly inner: IBlockchainService;
  private readonly client: CloudClient;
  private readonly chainIdValue: string | number;

  constructor(opts: { inner: IBlockchainService; client: CloudClient }) {
    this.inner = opts.inner;
    this.client = opts.client;
    this.chainIdValue = opts.inner.getChainId();
  }

  getChainId(): string | number {
    return this.inner.getChainId();
  }

  getChainName(): string {
    return this.inner.getChainName();
  }

  isValidAddress(address: string): boolean {
    return this.inner.isValidAddress(address);
  }

  async getTokenBalances(address: string): Promise<TokenBalance[]> {
    try {
      return (await this.client.chains.getTokenBalances.mutate({
        chainId: this.chainIdValue,
        address,
      })) as TokenBalance[];
    } catch (err) {
      throw CloudError.wrap(err);
    }
  }

  async hasActivity(address: string): Promise<boolean> {
    try {
      return await this.client.chains.hasActivity.mutate({
        chainId: this.chainIdValue,
        address,
      });
    } catch (err) {
      throw CloudError.wrap(err);
    }
  }

  async resolveAddressName(address: string): Promise<string | null> {
    try {
      return await this.client.chains.resolveAddressName.mutate({
        chainId: this.chainIdValue,
        address,
      });
    } catch {
      // Name resolution is best-effort: the real services swallow errors
      // and return null. Preserve that contract here so the detection
      // pipeline never blows up on an ENS miss.
      return null;
    }
  }
}

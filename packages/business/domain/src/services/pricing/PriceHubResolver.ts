import type { DatabaseTransaction } from '@scani/db';
import { createComponentLogger } from '@scani/logging';
import { Container, Service } from 'typedi';
import { TokenTypeRepository } from '../../repositories/EnumRepositories';
import { TokenRepository } from '../../repositories/TokenRepository';
import { PRICE_HUBS, type PriceHub, priceHubKey } from './price-hubs';

const USD: PriceHub = { symbol: 'USD', typeCode: 'fiat' };

/**
 * The tokens a price routes through, and USD, each addressed by its identity:
 * symbol, type and no market segment. A bare symbol names the newest row that
 * carries it, which for USD or EUR is a memecoin and for USDT one chain's
 * token (SC-223, SC-315).
 */
@Service()
export class PriceHubResolver {
  private readonly logger = createComponentLogger('service:PriceHubResolver');
  private readonly tokens = Container.get(TokenRepository);
  private readonly tokenTypes = Container.get(TokenTypeRepository);
  /** By hub, for the life of the process. A hub that resolves to nothing is kept too. */
  private readonly resolved = new Map<string, string | null>();

  /** In `PRICE_HUBS` order. Cached per process without a transaction, never with one (SC-600). */
  async hubTokenIds(tx?: DatabaseTransaction): Promise<string[]> {
    return this.tokenIdsOf(PRICE_HUBS, tx);
  }

  /** The hubs that resolve, in the order given, through the same cache. */
  async tokenIdsOf(hubs: readonly PriceHub[], tx?: DatabaseTransaction): Promise<string[]> {
    const ids: string[] = [];
    for (const hub of hubs) {
      const id = await this.resolve(hub, tx);
      if (id !== null) ids.push(id);
    }
    return ids;
  }

  /** The fiat USD, by identity. Throws when the catalogue has none. */
  async usdTokenId(tx?: DatabaseTransaction): Promise<string> {
    const id = await this.resolve(USD, tx);
    if (id === null) throw new Error('the catalogue has no fiat USD token');
    return id;
  }

  /**
   * A transaction neither reads the cache nor fills it (SC-600). Reading it, a
   * hub the pool could not resolve would stay unresolved for a transaction
   * that has just seeded it. Filling it, an id from a transaction that rolls
   * back would answer every later read.
   */
  private async resolve(hub: PriceHub, tx?: DatabaseTransaction): Promise<string | null> {
    if (tx !== undefined) return this.find(hub, tx);
    const key = priceHubKey(hub);
    const cached = this.resolved.get(key);
    if (cached !== undefined) return cached;
    const id = await this.find(hub, undefined);
    this.resolved.set(key, id);
    return id;
  }

  private async find(hub: PriceHub, tx: DatabaseTransaction | undefined): Promise<string | null> {
    const type = await this.tokenTypes.findByCode(hub.typeCode, tx);
    if (!type) {
      this.logger.warn({ hub }, 'hub token type is not seeded, hub disabled');
      return null;
    }
    const canonical = await this.tokens.findByIdentityTuple(hub.symbol, type.id, null, tx);
    if (canonical) return canonical.id;

    // Every hub is expected to have an un-segmented row, so this is a database
    // we do not recognise. The lane keeps working on a tie-broken row.
    const segmented = await this.tokens.findBySymbolAndType(hub.symbol, type.id, tx);
    if (segmented) {
      this.logger.warn(
        { hub, tokenId: segmented.id, marketSegment: segmented.marketSegment },
        'no canonical hub row, falling back to a tie-broken match'
      );
      return segmented.id;
    }
    this.logger.warn({ hub }, 'hub token not found, hub disabled');
    return null;
  }
}

import type { DatabaseTransaction } from '@scani/db';
import type { NewToken, Token } from '@scani/db/schema';
import type { Transaction } from '@scani/db/transaction';
import { Container, Service } from 'typedi';
import { TokenTypeRepository } from '../../repositories/EnumRepositories';
import { TokenRepository } from '../../repositories/TokenRepository';
import { TokenIdentityService } from '../tokens/TokenIdentityService';
import type { AssetRef } from './feed-batch';

/**
 * `skipped`: the catalog names no such token and the lookup may not create
 * one. `failed`: the lookup threw, and says why.
 */
export type AssetResolution =
  | { tokenId: string }
  | { skipped: string; ambiguous?: true }
  | { failed: string };

/** The token a batch's asset names (D-2). */
@Service()
export class AssetResolver {
  private readonly tokens = Container.get(TokenRepository);
  private readonly tokenTypes = Container.get(TokenTypeRepository);
  private readonly identities = Container.get(TokenIdentityService);

  /**
   * `catalog-symbol` is the statement import's lookup: the most legitimate
   * catalog token with the symbol (`TokenRepository.findBySymbol`). It never
   * creates one, in either mode, so a symbol the catalog lacks is skipped.
   * `catalog-symbol-of-type` is the same within the asset's type, for a
   * statement that names a security by its ticker alone, and skips a ticker
   * two listings share: a wrong listing is a wrong price (SC-1510).
   *
   * `identity` is a provider's, through `TokenIdentityService`, so its ISO-fiat
   * override and its scam refusal hold; `find-only` creates nothing. A lookup
   * that throws is answered `failed`, not raised. Inside a transaction it runs
   * in a savepoint, so a database error in it cannot abort the caller's batch
   * (ruling R35). Without one it runs on its own, and a token it creates is
   * committed whatever the batch then does.
   */
  async resolve(
    asset: AssetRef,
    mode: 'create' | 'find-only',
    tx: DatabaseTransaction | undefined
  ): Promise<AssetResolution> {
    if (asset.lookup === 'catalog-symbol') {
      const token = await this.tokens.findBySymbol(asset.identity.symbol, tx);
      return token
        ? { tokenId: token.id }
        : { skipped: `no catalog token has the symbol ${asset.identity.symbol}` };
    }

    const type = await this.tokenTypes.findByCode(asset.typeCode, tx);
    if (type === null) {
      throw new Error(`AssetResolver: no token type has the code ${asset.typeCode}`);
    }
    if (asset.lookup === 'catalog-symbol-of-type') {
      const listings = await this.tokens.findCatalogListingsOfType(
        asset.identity.symbol,
        type.id,
        tx
      );
      if (listings.length === 1) return { tokenId: listings[0]!.id };
      return listings.length === 0
        ? { skipped: `no catalog ${asset.typeCode} has the symbol ${asset.identity.symbol}` }
        : {
            skipped: `more than one catalog ${asset.typeCode} has the symbol ${asset.identity.symbol}`,
            ambiguous: true,
          };
    }
    const partial: Partial<NewToken> = { ...asset.identity, typeId: type.id };
    const lookup = (within?: Transaction): Promise<Token | null> =>
      mode === 'find-only'
        ? this.identities.findByIdentity(partial, within)
        : this.identities.findOrCreateByIdentity(partial, within);
    try {
      const token = tx === undefined ? await lookup() : await tx.transaction(lookup);
      return token
        ? { tokenId: token.id }
        : { skipped: `no token has the identity of ${asset.identity.symbol}` };
    } catch (error) {
      return { failed: error instanceof Error ? error.message : String(error) };
    }
  }
}

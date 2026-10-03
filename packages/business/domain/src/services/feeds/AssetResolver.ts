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
export type AssetResolution = { tokenId: string } | { skipped: string } | { failed: string };

/**
 * Two refs with this key resolve to one token, so a batch resolves each key
 * once. It is every field a lookup matches on and never the symbol alone: two
 * tokens can share a symbol. A display field (name, decimals, icon) is not in
 * it, so two refs of one token that spell its name differently are one lookup.
 */
export function assetKey(asset: AssetRef): string {
  const { symbol, marketSegment, providerMetadata } = asset.identity;
  return JSON.stringify([
    asset.lookup ?? 'identity',
    asset.typeCode,
    symbol,
    marketSegment ?? null,
    providerMetadata ?? null,
  ]);
}

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

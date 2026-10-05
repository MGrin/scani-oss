import type { Token } from '@scani/db/schema';
import { Container } from 'typedi';
import { TokenRepository } from '../../src/repositories/TokenRepository';
import { PriceHubResolver } from '../../src/services/pricing/PriceHubResolver';
import { snapshotContainer } from './container';

/**
 * Registers the real `PriceHubResolver` over a token lookup that answers a
 * symbol and type with what `answer` gives: a token, `null` for nothing, or
 * `undefined` for the catalogue's own answer. No catalogue row changes, so a
 * killed run leaves the database as it was.
 *
 * Returns the undo, which puts back everything registered since the call.
 */
function resolverAnswering(
  answer: (symbol: string, typeId: string) => Token | null | undefined
): () => void {
  const restore = snapshotContainer();
  const tokens = Container.get(TokenRepository);
  const lookup: Pick<TokenRepository, 'findByIdentityTuple' | 'findBySymbolAndType'> = {
    findByIdentityTuple: async (symbol, typeId, ...rest) => {
      const answered = answer(symbol, typeId);
      return answered === undefined
        ? tokens.findByIdentityTuple(symbol, typeId, ...rest)
        : answered;
    },
    findBySymbolAndType: async (symbol, typeId, ...rest) => {
      const answered = answer(symbol, typeId);
      return answered === undefined
        ? tokens.findBySymbolAndType(symbol, typeId, ...rest)
        : answered;
    },
  };
  // The resolver takes its lookup from the container when it is built.
  Container.set(TokenRepository, lookup as unknown as TokenRepository);
  const resolver = new PriceHubResolver();
  Container.set(TokenRepository, tokens);
  Container.set(PriceHubResolver, resolver);
  return restore;
}

/** A `PriceHubResolver` that finds nothing for the symbols `hidden` names. */
function resolverBlindTo(hidden: (symbol: string) => boolean): () => void {
  return resolverAnswering((symbol) => (hidden(symbol) ? null : undefined));
}

/**
 * Registers a `PriceHubResolver` that finds, for each symbol `hubs` names, the
 * token given when asked in that token's type, and the catalogue's row for
 * anything else. A run that prices the hubs then writes rows for these tokens
 * and none for the seeded ones. Returns the undo. Build whatever must read the
 * resolver between the two.
 */
export function withHubs(hubs: ReadonlyMap<string, Token>): () => void {
  return resolverAnswering((symbol, typeId) => {
    const token = hubs.get(symbol);
    return token?.typeId === typeId ? token : undefined;
  });
}

/**
 * Registers a `PriceHubResolver` that finds no fiat USD. Returns the undo.
 * Build whatever must read the resolver between the two.
 */
export function withoutFiatUsd(): () => void {
  return resolverBlindTo((symbol) => symbol === 'USD');
}

/**
 * Leaves the hourly run no currency of its own to price, so its tokens are the
 * held ones a test hands it: a `PriceHubResolver` that finds the fiat USD and
 * no other hub or baseline currency, and a `TokenRepository` that reports no
 * currency in use. Returns the undo. Build the run between the two.
 */
export function withoutCurrenciesToPrice(): () => void {
  const restore = resolverBlindTo((symbol) => symbol !== 'USD');
  const tokens = new TokenRepository();
  tokens.findCurrencyTokenIdsInUse = async () => [];
  Container.set(TokenRepository, tokens);
  return restore;
}

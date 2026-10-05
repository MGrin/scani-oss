import { Container } from 'typedi';
import { TokenRepository } from '../../src/repositories/TokenRepository';
import { PriceHubResolver } from '../../src/services/pricing/PriceHubResolver';
import { snapshotContainer } from './container';

/**
 * Registers a `PriceHubResolver` that finds no fiat USD: the real resolver
 * over a token lookup that answers nothing for that symbol. No catalogue row
 * changes, so a killed run leaves the database as it was.
 *
 * Returns the undo, which puts back everything registered since the call.
 * Build whatever must read the resolver between the two.
 */
export function withoutFiatUsd(): () => void {
  const restore = snapshotContainer();
  const tokens = Container.get(TokenRepository);
  const lookup: Pick<TokenRepository, 'findByIdentityTuple' | 'findBySymbolAndType'> = {
    findByIdentityTuple: async (symbol, ...rest) =>
      symbol === 'USD' ? null : tokens.findByIdentityTuple(symbol, ...rest),
    findBySymbolAndType: async (symbol, ...rest) =>
      symbol === 'USD' ? null : tokens.findBySymbolAndType(symbol, ...rest),
  };
  // The resolver takes its lookup from the container when it is built.
  Container.set(TokenRepository, lookup as unknown as TokenRepository);
  const resolver = new PriceHubResolver();
  Container.set(TokenRepository, tokens);
  Container.set(PriceHubResolver, resolver);
  return restore;
}

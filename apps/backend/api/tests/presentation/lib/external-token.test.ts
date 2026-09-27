import { describe, expect, it } from 'bun:test';
import {
  externalSearchMetadata,
  matchVerifiedExternalToken,
} from '../../../src/presentation/lib/external-token';

const bitcoin = {
  symbol: 'BTC',
  name: 'Bitcoin',
  type: 'Crypto',
  currency: 'USD',
  provider: 'coingecko',
  providerMetadata: { id: 'bitcoin' },
};
const apple = {
  symbol: 'AAPL',
  name: 'Apple Inc',
  type: 'Common Stock',
  currency: 'USD',
  provider: 'finnhub',
  providerMetadata: { searchResult: { symbol: 'AAPL' } },
};
const serverResults = [bitcoin, apple];

describe('matchVerifiedExternalToken (SC-1339)', () => {
  it('refuses a CoinGecko id the provider does not return for that symbol', () => {
    const planted = { ...externalSearchMetadata(bitcoin), id: 'some-other-coin' };
    expect(
      matchVerifiedExternalToken(serverResults, {
        symbol: 'BTC',
        provider: 'coingecko',
        metadata: planted,
      })
    ).toBeNull();
  });

  it('refuses a symbol the provider did not return at all', () => {
    expect(
      matchVerifiedExternalToken(serverResults, {
        symbol: 'NEWCOIN',
        provider: 'coingecko',
        metadata: { name: 'New', type: 'Crypto', id: 'bitcoin' },
      })
    ).toBeNull();
  });

  it('refuses a CoinGecko pick that names no id', () => {
    const { id: _id, ...noId } = externalSearchMetadata(bitcoin);
    expect(
      matchVerifiedExternalToken(serverResults, {
        symbol: 'BTC',
        provider: 'coingecko',
        metadata: noId,
      })
    ).toBeNull();
  });

  it('returns the SERVER metadata, not the client copy, for a genuine pick', () => {
    const clientCopy = { ...externalSearchMetadata(bitcoin), name: 'Totally Bitcoin' };
    const verified = matchVerifiedExternalToken(serverResults, {
      symbol: 'BTC',
      provider: 'coingecko',
      metadata: clientCopy,
    });
    expect(verified).toEqual(externalSearchMetadata(bitcoin));
    expect(verified?.name).toBe('Bitcoin');
  });

  it('matches a Finnhub pick by ticker', () => {
    expect(
      matchVerifiedExternalToken(serverResults, {
        symbol: 'AAPL',
        provider: 'finnhub',
        metadata: externalSearchMetadata(apple),
      })
    ).toEqual(externalSearchMetadata(apple));
  });

  it('does not match across providers', () => {
    expect(
      matchVerifiedExternalToken(serverResults, {
        symbol: 'AAPL',
        provider: 'coingecko',
        metadata: { ...externalSearchMetadata(apple), id: 'aapl' },
      })
    ).toBeNull();
  });
});

import { describe, expect, it } from 'bun:test';
import {
  confirmExternalPick,
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

describe('confirmExternalPick (SC-1766)', () => {
  // Keyless CoinGecko answers one search every 6 s, so each confirm search a
  // pick spends is one the user waits for.
  const pick = {
    symbol: 'BTC',
    provider: 'coingecko' as const,
    metadata: { name: 'Bitcoin', providerMetadata: { id: 'bitcoin' } },
  };

  it('confirms with one search when the name finds the pick', async () => {
    const asked: string[] = [];
    const confirmed = await confirmExternalPick(pick, async (query) => {
      asked.push(query);
      return [bitcoin];
    });
    expect(confirmed?.symbol).toBe('BTC');
    expect(asked).toEqual(['Bitcoin']);
  });

  it('asks by symbol only when the name search does not keep the pick', async () => {
    const asked: string[] = [];
    const confirmed = await confirmExternalPick(pick, async (query) => {
      asked.push(query);
      return query === 'BTC' ? [bitcoin] : [];
    });
    expect(confirmed?.symbol).toBe('BTC');
    expect(asked).toEqual(['Bitcoin', 'BTC']);
  });

  it('control: a pick neither search returns is refused', async () => {
    expect(await confirmExternalPick(pick, async () => [apple])).toBeNull();
  });
});

import '../../i18n-preload';
import { describe, expect, test } from 'bun:test';
import {
  classifyWalletFetch,
  deriveWalletSelection,
  initialWalletSelection,
  readChainErrors,
  readWalletImport,
  spamSignal,
  type WalletChainGroup,
} from '../../../src/v3/lib/wallet-import';

function snapshot(externalId: string, symbol: string, name: string, balance = '1') {
  return {
    externalId,
    balance,
    capturedAt: '2026-08-01T00:00:00.000Z',
    tokenIdentity: { symbol, name },
  };
}

describe('reading a wallet-import result', () => {
  test('a needsReview payload with no chains array is unavailable, not empty', () => {
    const view = readWalletImport({ needsReview: true, candidateCount: 2766, chainsDetected: 4 });
    expect(view.kind).toBe('unavailable');
    if (view.kind !== 'unavailable') throw new Error('unreachable');
    expect(view.candidateCount).toBe(2766);
    expect(view.chainsDetected).toBe(4);
  });

  test('chainsDetected is what the address was found on, never what answered', () => {
    // One chain detected, none read: v2 reported this as "0 tokens across 0
    // chains" before SC-139, which reads as an empty wallet.
    const view = readWalletImport({
      needsReview: true,
      chains: [],
      chainsDetected: 3,
      errors: [{ chainName: 'Base', error: 'RPC timeout' }],
    });
    expect(view.kind).toBe('review');
    if (view.kind !== 'review') throw new Error('unreachable');
    expect(view.chainsDetected).toBe(3);
    expect(view.outcome).toBe('unreadable');
  });

  test('a legacy result keeps its holding order', () => {
    const view = readWalletImport({
      holdingIds: ['c', 'a', 'b'],
      accountsCreated: 2,
      holdingsCreated: 3,
      chainsDetected: ['Ethereum', 'Base'],
    });
    expect(view.kind).toBe('imported');
    if (view.kind !== 'imported') throw new Error('unreachable');
    expect(view.holdingIds).toEqual(['c', 'a', 'b']);
    expect(view.chainNames).toEqual(['Ethereum', 'Base']);
    expect(view.chainsDetected).toBe(2);
  });

  test('a candidate key survives the same token address on two chains', () => {
    const view = readWalletImport({
      needsReview: true,
      chainsDetected: 2,
      chains: [
        {
          institutionId: 'eth',
          institutionName: 'Ethereum',
          snapshots: [snapshot('0xabc', 'USDC', 'USD Coin')],
        },
        {
          institutionId: 'base',
          institutionName: 'Base',
          snapshots: [snapshot('0xabc', 'USDC', 'USD Coin')],
        },
      ],
    });
    if (view.kind !== 'review') throw new Error('unreachable');
    expect(view.chains.map((c) => c.candidates[0]?.key)).toEqual(['eth:0xabc', 'base:0xabc']);
  });

  test('nothing is dropped from an unrecognised error shape', () => {
    expect(readChainErrors(['plain', { chainName: 'Base', error: 'boom' }, { odd: 1 }])).toEqual([
      'plain',
      'Base: boom',
      '{"odd":1}',
    ]);
  });
});

describe('a closed position on the review card (SC-398)', () => {
  // MUST-BE-FOUND. A position the wallet traded and exited arrives at balance
  // `0`, and the card has to be able to say WHY it is there — a bare `0` reads
  // as an empty row somebody forgot to filter out, which is the opposite of
  // what it is.
  test('an exited row is flagged', () => {
    const view = readWalletImport({
      needsReview: true,
      chainsDetected: 1,
      chains: [
        {
          institutionId: 'eth',
          institutionName: 'Ethereum',
          snapshots: [
            { ...snapshot('0xgala', 'GALA', 'Gala', '0'), exitedPosition: true },
            snapshot('0xusdc', 'USDC', 'USD Coin', '5'),
          ],
        },
      ],
    });
    if (view.kind !== 'review') throw new Error('unreachable');
    expect(view.chains[0]?.candidates.map((c) => [c.symbol, c.exited])).toEqual([
      ['GALA', true],
      ['USDC', false],
    ]);
  });

  // MUST-BE-ABSENT, and it is the reason the flag is carried rather than read
  // off `balance === '0'`: a review job enqueued before this shipped has no
  // such key, and every row in it is a current balance. Inferring from the
  // balance would relabel any zero row in an old payload.
  test('a payload written before the flag existed claims nothing', () => {
    const view = readWalletImport({
      needsReview: true,
      chainsDetected: 1,
      chains: [
        {
          institutionId: 'eth',
          institutionName: 'Ethereum',
          snapshots: [snapshot('0xdust', 'DUST', 'Dust', '0')],
        },
      ],
    });
    if (view.kind !== 'review') throw new Error('unreachable');
    expect(view.chains[0]?.candidates[0]?.exited).toBe(false);
  });
});

describe('classifying the fetch', () => {
  test('empty and unreadable never collapse', () => {
    expect(classifyWalletFetch(0, 0)).toBe('empty');
    expect(classifyWalletFetch(0, 2)).toBe('unreadable');
    expect(classifyWalletFetch(5, 0)).toBe('found');
    expect(classifyWalletFetch(5, 2)).toBe('partial');
  });
});

describe('the spam heuristic', () => {
  test('flags a solicitation in the name', () => {
    expect(spamSignal('CLAIM', 'Claim 5000 USDT at t.me/x')).toBe('solicitation');
    expect(spamSignal('AIRDROP', null)).toBe('solicitation');
  });

  test('flags a homoglyph — one word carrying both alphabets', () => {
    // The C is Cyrillic Es. This is the attack the rule exists for.
    expect(spamSignal('USDС', 'USD Coin')).toBe('mixedScript');
  });

  test('does NOT flag a token named in Russian', () => {
    // v2 tests the whole string for any Cyrillic letter, so both of these are
    // unticked and hidden by default in an app that ships a Russian interface.
    expect(spamSignal('RUB', 'Российский рубль')).toBeNull();
    expect(spamSignal('SBER', 'Сбербанк')).toBeNull();
    expect(spamSignal('TRUB', 'Тинькофф Рубль')).toBeNull();
  });

  test('leaves an ordinary token alone', () => {
    expect(spamSignal('ETH', 'Ethereum')).toBeNull();
  });
});

describe('what the confirm button will write', () => {
  const chains: WalletChainGroup[] = [
    {
      institutionId: 'eth',
      institutionName: 'Ethereum',
      candidates: [
        {
          key: 'eth:1',
          institutionId: 'eth',
          externalId: '1',
          symbol: 'ETH',
          name: 'Ethereum',
          balance: '2',
          spam: null,
          exited: false,
        },
        {
          key: 'eth:2',
          institutionId: 'eth',
          externalId: '2',
          symbol: 'CLAIM',
          name: 'Claim now',
          balance: '9',
          spam: 'solicitation',
          exited: false,
        },
      ],
    },
  ];

  test('a fresh review starts with the flagged rows unticked', () => {
    expect([...initialWalletSelection(chains)]).toEqual(['eth:1']);
  });

  test('a ticked row hidden by the filter is reported, not silently written', () => {
    // Tick everything with the filter off, then turn it back on. v2 renders
    // "2 of 2" and "Import 2 holdings" over a list of one, with nothing on
    // screen naming the second.
    const selected = new Set(['eth:1', 'eth:2']);
    const state = deriveWalletSelection(chains, selected, true);
    expect(state.visibleCount).toBe(1);
    expect(state.kept).toHaveLength(2);
    expect(state.hiddenSelected.map((row) => row.key)).toEqual(['eth:2']);
  });

  test('nothing is hidden when the filter is off', () => {
    const state = deriveWalletSelection(chains, new Set(['eth:1', 'eth:2']), false);
    expect(state.visibleCount).toBe(2);
    expect(state.hiddenSelected).toEqual([]);
  });

  test('a chain that filters to nothing is dropped rather than rendered empty', () => {
    const spamOnly: WalletChainGroup[] = [
      { ...chains[0]!, candidates: [chains[0]!.candidates[1]!] },
    ];
    expect(deriveWalletSelection(spamOnly, new Set(), true).groups).toEqual([]);
  });

  test('a selection key with no candidate behind it cannot reach the payload', () => {
    const state = deriveWalletSelection(chains, new Set(['eth:1', 'eth:gone']), false);
    expect(state.kept).toEqual([{ institutionId: 'eth', externalId: '1' }]);
  });
});

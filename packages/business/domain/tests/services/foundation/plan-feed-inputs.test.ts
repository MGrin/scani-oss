import { describe, expect, test } from 'bun:test';
import { inputSourceClass } from '../../../src/services/foundation/legacy-ledger-kinds';
import {
  type AccountInputFacts,
  type PlannedFeedInput,
  planFeedInputs,
} from '../../../src/services/foundation/plan-feed-inputs';

function facts(overrides: Partial<AccountInputFacts> = {}): AccountInputFacts {
  return {
    userId: 'u1',
    accountId: 'a1',
    institutionName: 'Ethereum',
    chainId: null,
    walletId: null,
    walletActive: false,
    credentialId: null,
    credentialActive: false,
    hasProviderHoldings: false,
    hasCexLedger: false,
    hasStatementEvidence: false,
    hasWalletEvidence: false,
    ...overrides,
  };
}

function input(overrides: Partial<PlannedFeedInput> & Pick<PlannedFeedInput, 'source'>) {
  return {
    userId: 'u1',
    accountId: 'a1',
    credentialId: null,
    walletId: null,
    status: 'active',
    ...overrides,
  } satisfies PlannedFeedInput;
}

describe('planFeedInputs: wallet accounts', () => {
  test('an active EVM wallet is an active etherscan input', () => {
    expect(planFeedInputs(facts({ chainId: 1, walletId: 'w1', walletActive: true }))).toEqual([
      input({ source: 'etherscan', walletId: 'w1' }),
    ]);
  });

  test('a non-EVM chain uses its own source, whether the id is stored as a number or a string', () => {
    expect(planFeedInputs(facts({ chainId: -2, walletId: 'w1', walletActive: true }))).toEqual([
      input({ source: 'solana', walletId: 'w1' }),
    ]);
    expect(planFeedInputs(facts({ chainId: '-2', walletId: 'w1', walletActive: true }))).toEqual([
      input({ source: 'solana', walletId: 'w1' }),
    ]);
  });

  test('an inactive wallet is disconnected', () => {
    expect(planFeedInputs(facts({ chainId: 1, walletId: 'w1', walletActive: false }))).toEqual([
      input({ source: 'etherscan', walletId: 'w1', status: 'disconnected' }),
    ]);
  });

  test('a wallet on a chain no source covers falls back to wallet', () => {
    expect(planFeedInputs(facts({ chainId: 999_999, walletId: 'w1', walletActive: true }))).toEqual(
      [input({ source: 'wallet', walletId: 'w1' })]
    );
    expect(planFeedInputs(facts({ chainId: null, walletId: 'w1', walletActive: true }))).toEqual([
      input({ source: 'wallet', walletId: 'w1' }),
    ]);
  });

  test('a chain id with no linked wallet plans no wallet input', () => {
    expect(planFeedInputs(facts({ chainId: 1, walletId: null }))).toEqual([]);
  });

  test('wallet evidence on a chain with no linked wallet keeps a disconnected wallet input', () => {
    expect(planFeedInputs(facts({ chainId: 1, hasWalletEvidence: true }))).toEqual([
      input({ source: 'etherscan', status: 'disconnected' }),
    ]);
    expect(planFeedInputs(facts({ chainId: '-2', hasWalletEvidence: true }))).toEqual([
      input({ source: 'solana', status: 'disconnected' }),
    ]);
    expect(planFeedInputs(facts({ chainId: 999_999, hasWalletEvidence: true }))).toEqual([
      input({ source: 'wallet', status: 'disconnected' }),
    ]);
    // With no chain there is no way to name the source, so no input.
    expect(planFeedInputs(facts({ chainId: null, hasWalletEvidence: true }))).toEqual([]);
  });

  test('a linked wallet takes its status from the wallet, whatever the evidence', () => {
    expect(
      planFeedInputs(
        facts({ chainId: 1, walletId: 'w1', walletActive: true, hasWalletEvidence: true })
      )
    ).toEqual([input({ source: 'etherscan', walletId: 'w1' })]);
  });
});

describe('planFeedInputs: credential accounts', () => {
  test('a Kraken credential with provider holdings is a kraken-api input', () => {
    expect(
      planFeedInputs(
        facts({
          institutionName: 'Kraken',
          credentialId: 'c1',
          credentialActive: true,
          hasProviderHoldings: true,
        })
      )
    ).toEqual([input({ source: 'kraken-api', credentialId: 'c1' })]);
  });

  test('a provider with no ledger source is provider:<lowercased name>', () => {
    expect(
      planFeedInputs(
        facts({
          institutionName: 'Wise',
          credentialId: 'c1',
          credentialActive: true,
          hasProviderHoldings: true,
        })
      )
    ).toEqual([input({ source: 'provider:wise', credentialId: 'c1' })]);
  });

  test('CEX ledger rows alone are enough for a provider input', () => {
    expect(
      planFeedInputs(
        facts({
          institutionName: 'Interactive Brokers',
          credentialId: 'c1',
          credentialActive: true,
          hasCexLedger: true,
        })
      )
    ).toEqual([input({ source: 'ibkr-api', credentialId: 'c1' })]);
  });

  test('an inactive credential is disconnected', () => {
    expect(
      planFeedInputs(
        facts({
          institutionName: 'Kraken',
          credentialId: 'c1',
          credentialActive: false,
          hasProviderHoldings: true,
        })
      )
    ).toEqual([input({ source: 'kraken-api', credentialId: 'c1', status: 'disconnected' })]);
  });

  test('a credential with neither provider holdings nor a CEX ledger plans no provider input', () => {
    expect(
      planFeedInputs(
        facts({ institutionName: 'Kraken', credentialId: 'c1', credentialActive: true })
      )
    ).toEqual([]);
  });

  test('a deleted credential leaves a disconnected provider input, so its ledger keeps a source', () => {
    expect(
      planFeedInputs(facts({ institutionName: 'Kraken', credentialId: null, hasCexLedger: true }))
    ).toEqual([input({ source: 'kraken-api', status: 'disconnected' })]);
    expect(
      planFeedInputs(
        facts({ institutionName: 'Wise', credentialId: null, hasProviderHoldings: true })
      )
    ).toEqual([input({ source: 'provider:wise', status: 'disconnected' })]);
    // No credential and no provider evidence is not a provider account at all.
    expect(planFeedInputs(facts({ institutionName: 'Kraken', credentialId: null }))).toEqual([]);
  });
});

describe('planFeedInputs: statements and combinations', () => {
  test('statement evidence is a statement input', () => {
    expect(planFeedInputs(facts({ hasStatementEvidence: true }))).toEqual([
      input({ source: 'statement' }),
    ]);
  });

  test('a wallet with statement evidence has two inputs', () => {
    expect(
      planFeedInputs(
        facts({ chainId: 1, walletId: 'w1', walletActive: true, hasStatementEvidence: true })
      )
    ).toEqual([input({ source: 'etherscan', walletId: 'w1' }), input({ source: 'statement' })]);
  });

  test('no facts plan nothing', () => {
    expect(planFeedInputs(facts())).toEqual([]);
  });

  test('every planned source classifies as the kind of input it was planned for', () => {
    const planned = planFeedInputs(
      facts({
        institutionName: 'Wise',
        chainId: 999_999,
        walletId: 'w1',
        walletActive: true,
        credentialId: 'c1',
        credentialActive: true,
        hasProviderHoldings: true,
        hasStatementEvidence: true,
      })
    );
    expect(planned.map((p) => [p.source, inputSourceClass(p.source)])).toEqual([
      ['wallet', 'wallet'],
      ['provider:wise', 'provider'],
      ['statement', 'statement'],
    ]);
  });
});

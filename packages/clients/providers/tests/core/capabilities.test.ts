import { describe, expect, test } from 'bun:test';
import {
  isAccountDiscoveryProvider,
  isAddressValidatorProvider,
  isAIInferenceProvider,
  isBalanceProvider,
  isCredentialValidator,
  isCurrentPriceProvider,
  isHistoricalPriceProvider,
  isTokenIdentityProvider,
  isTransactionsProvider,
} from '../../src/core/capabilities';

describe('capability guards', () => {
  test('isCurrentPriceProvider passes when both methods exist', () => {
    expect(isCurrentPriceProvider({ canPrice: () => true, fetchCurrentPrice: () => null })).toBe(
      true
    );
  });

  test('isCurrentPriceProvider fails when canPrice missing', () => {
    expect(isCurrentPriceProvider({ fetchCurrentPrice: () => null })).toBe(false);
  });

  test('isHistoricalPriceProvider requires CurrentPrice + fetchHistoricalPrice', () => {
    expect(
      isHistoricalPriceProvider({
        canPrice: () => true,
        fetchCurrentPrice: () => null,
        fetchHistoricalPrice: () => null,
      })
    ).toBe(true);
    expect(isHistoricalPriceProvider({ canPrice: () => true, fetchCurrentPrice: () => null })).toBe(
      false
    );
  });

  test('isBalanceProvider requires canFetchBalances + fetchBalances', () => {
    expect(isBalanceProvider({ canFetchBalances: () => true, fetchBalances: () => [] })).toBe(true);
    expect(isBalanceProvider({ canFetchBalances: () => true })).toBe(false);
  });

  test('isTransactionsProvider requires canFetchTransactions + fetchTransactions', () => {
    expect(
      isTransactionsProvider({
        canFetchTransactions: () => true,
        fetchTransactions: () => [],
      })
    ).toBe(true);
  });

  test('isCredentialValidator requires validateCredentials', () => {
    expect(isCredentialValidator({ validateCredentials: () => ({ valid: true }) })).toBe(true);
    expect(isCredentialValidator({})).toBe(false);
  });

  test('isTokenIdentityProvider requires enrichTokenIdentity', () => {
    expect(isTokenIdentityProvider({ enrichTokenIdentity: () => null })).toBe(true);
  });

  test('isAIInferenceProvider requires parseScreenshot', () => {
    expect(isAIInferenceProvider({ parseScreenshot: () => ({}) })).toBe(true);
  });

  test('isAddressValidatorProvider requires canValidate + isValidAddress + hasActivity', () => {
    expect(
      isAddressValidatorProvider({
        canValidate: () => true,
        isValidAddress: () => true,
        hasActivity: () => true,
      })
    ).toBe(true);
    expect(
      isAddressValidatorProvider({
        canValidate: () => true,
        isValidAddress: () => true,
      })
    ).toBe(false);
  });

  test('isAccountDiscoveryProvider requires canDiscoverAccounts + fetchAccounts', () => {
    expect(
      isAccountDiscoveryProvider({
        canDiscoverAccounts: () => true,
        fetchAccounts: () => [],
      })
    ).toBe(true);
    expect(isAccountDiscoveryProvider({ canDiscoverAccounts: () => true })).toBe(false);
  });

  test('all guards reject null / non-objects (catches typos at the registry seam)', () => {
    for (const guard of [
      isCurrentPriceProvider,
      isHistoricalPriceProvider,
      isBalanceProvider,
      isTransactionsProvider,
      isCredentialValidator,
      isTokenIdentityProvider,
      isAIInferenceProvider,
      isAddressValidatorProvider,
      isAccountDiscoveryProvider,
    ]) {
      expect(guard(null)).toBe(false);
      expect(guard(undefined)).toBe(false);
      expect(guard('not-an-object')).toBe(false);
      expect(guard(42)).toBe(false);
    }
  });
});

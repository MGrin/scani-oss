/**
 * `ChainStubProvider` — fixed-fixture chain provider used by the e2e suite.
 *
 * Registered only when `STUB_CHAIN_DATA === '1'` is in the env, ahead of
 * the real chain providers, so `hasActivity` / `fetchBalances` /
 * `fetchTransactions` for every chain resolve from a local fixture
 * instead of blockchain.info, an Etherscan key, a Solana RPC, TronGrid
 * or Toncenter.
 *
 * Why this exists: `apps/e2e/tests/wallet-import/import-flow.spec.ts`
 * imported the Bitcoin genesis address against LIVE blockchain.info,
 * inside the `E2E (Playwright)` job that `CI Success` is gated on. Three
 * suite runs from one IP earn a 429 that lasts 40+ minutes (SC-364), so
 * the gate protecting every OSS merge depended on a third party's rate
 * limiter. The address is also structurally valid base58, so detection
 * probed a public Solana RPC on the same run.
 *
 * What it does NOT do: it does not make failures disappear. A stubbed
 * boot answers from fixtures; an unstubbed one still calls the chain and
 * still reports a probe that could not be completed (see
 * `WalletDiscoveryService.detectWalletChains`). A stub that always
 * succeeded would hide exactly the regression this gate exists to catch.
 *
 * Refusal in production: `STUB_CHAIN_DATA=1` is rejected by the api,
 * worker and data-provider env schemas when `NODE_ENV=production`, so a
 * misconfigured prod deploy crashes at boot rather than serving fixture
 * balances to a user.
 */

import { type CustomLogger, createComponentLogger } from '@scani/logging';
import type { ProviderFactory } from '../../core/boot';
import type {
  AddressValidatorProvider,
  BalanceProvider,
  Capability,
  TransactionsProvider,
} from '../../core/capabilities';
import type {
  HoldingSnapshot,
  ProviderContext,
  TokenIdentity,
  TransactionEvent,
  WithUserCreds,
} from '../../core/types';
import { isBitcoinAddress } from '../bitcoin';
import { isEvmAddress } from '../etherscan';
import { ETHERSCAN_CHAINS } from '../etherscan/chains';
import { isSolanaAddress } from '../solana';
import { isTonAddress } from '../ton';
import { isTronAddress } from '../tron';

interface StubChain {
  /** Structural address check — the real provider's own, imported so a
      stubbed boot and a live boot cannot disagree about address shape. */
  matches: (address: string) => boolean;
  native: { symbol: string; name: string; decimals: number };
}

const NON_EVM: Readonly<Record<string, StubChain>> = {
  bitcoin: { matches: isBitcoinAddress, native: { symbol: 'BTC', name: 'Bitcoin', decimals: 8 } },
  solana: { matches: isSolanaAddress, native: { symbol: 'SOL', name: 'Solana', decimals: 9 } },
  tron: { matches: isTronAddress, native: { symbol: 'TRX', name: 'Tron', decimals: 6 } },
  ton: { matches: isTonAddress, native: { symbol: 'TON', name: 'Toncoin', decimals: 9 } },
};

/**
 * Every institution code the stub answers for. EVM rows come from the
 * Etherscan catalog rather than a second list, so a chain added there is
 * stubbed automatically instead of quietly falling through to the live
 * provider.
 */
const STUB_CHAINS: ReadonlyMap<string, StubChain> = new Map<string, StubChain>([
  ...ETHERSCAN_CHAINS.map(
    (c) =>
      [
        c.institutionCode,
        {
          matches: isEvmAddress,
          native: { symbol: c.nativeSymbol, name: c.nativeName, decimals: c.nativeDecimals },
        },
      ] as const
  ),
  ...Object.entries(NON_EVM),
]);

/**
 * Fixture wallets: address → the native balance the stub reports per
 * institution code. An address absent from this table has activity
 * nowhere and holds nothing, which is what makes the stub deterministic
 * — it is a fixture, not a simulator.
 */
const STUB_WALLETS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // Bitcoin genesis block reward address. `import-flow.spec.ts` imports
  // it and asserts BTC reaches the review payload; 50 BTC is what the
  // live address has held, unspendable, since 2009.
  '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa': { bitcoin: '50' },
};

function fixtureBalance(address: string, institutionCode: string): string | null {
  return STUB_WALLETS[address]?.[institutionCode] ?? null;
}

export class ChainStubProvider
  implements BalanceProvider, TransactionsProvider, AddressValidatorProvider
{
  readonly providerKey = 'chain-stub';
  readonly capabilities: readonly Capability[] = [
    'current-balances',
    'transactions',
    'address-validator',
  ];

  private readonly logger: CustomLogger;

  constructor() {
    this.logger = createComponentLogger('provider:chain-stub');
  }

  canFetchBalances(institutionCode: string): boolean {
    return STUB_CHAINS.has(institutionCode);
  }

  canFetchTransactions(institutionCode: string): boolean {
    return STUB_CHAINS.has(institutionCode);
  }

  canValidate(institutionCode: string): boolean {
    return STUB_CHAINS.has(institutionCode);
  }

  isValidAddress(address: string, institutionCode: string): boolean {
    return STUB_CHAINS.get(institutionCode)?.matches(address) ?? false;
  }

  hasActivity(address: string, institutionCode: string, _ctx: ProviderContext): Promise<boolean> {
    if (!this.isValidAddress(address, institutionCode)) return Promise.resolve(false);
    return Promise.resolve(fixtureBalance(address, institutionCode) !== null);
  }

  async fetchBalances(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<HoldingSnapshot[]> {
    const creds = await ctx.resolveCredentials(ctx.credentialsRef);
    const address =
      (creds.walletAddress as string | undefined) ?? (creds.address as string | undefined);
    const chain = STUB_CHAINS.get(ctx.institutionCode);
    const balance = address ? fixtureBalance(address, ctx.institutionCode) : null;
    if (!chain || balance === null) {
      // Not a warning: "this address is not a fixture" is the stub
      // working. Logged so a developer running with the stub on does not
      // read an empty wallet as a broken one.
      this.logger.info(
        { institutionCode: ctx.institutionCode, hasAddress: Boolean(address) },
        'chain-stub: no fixture for this address on this chain; reporting no holdings'
      );
      return [];
    }

    const tokenIdentity: TokenIdentity = {
      symbol: chain.native.symbol,
      name: chain.native.name,
      decimals: chain.native.decimals,
      providerMetadata: {},
    };
    return [
      {
        externalId: 'native',
        tokenIdentity,
        balance,
        capturedAt: new Date(),
      },
    ];
  }

  /**
   * Fixture wallets have no transaction history. Present so that a flow
   * which imports a wallet and then enqueues its transaction import
   * cannot reach a live chain API through the back door — the whole
   * point of the stub is that nothing does.
   */
  fetchTransactions(
    _ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<TransactionEvent[]> {
    return Promise.resolve([]);
  }
}

export const chainStubFactory: ProviderFactory = async (_deps) => {
  return new ChainStubProvider();
};

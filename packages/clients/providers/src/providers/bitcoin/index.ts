/**
 * `BitcoinProvider` — balances + transactions for Bitcoin mainnet via
 * the public `blockchain.info` API.
 *
 * Capabilities:
 *  - `current-balances`: `https://blockchain.info/rawaddr/{addr}` →
 *    final_balance in satoshis. No key required.
 *  - `transactions`: paginates `/rawaddr/{addr}?limit=50&offset=N`,
 *    summing per-tx inflow/outflow against the wallet to derive a
 *    signed net delta.
 *  - `address-validator`: structural checks for P2PKH, P2SH, Bech32.
 *
 * Self-credentialed at the type level: the wallet address is
 * provided in `ctx.credentialsRef` (BTC integrations store the
 * address as the credential payload — there's no API key).
 */

import type { NewToken } from '@scani/db/schema';
import { type CustomLogger, createComponentLogger } from '@scani/logging';
import { createOutflowLimiter, type OutflowRateLimiter } from '@scani/rate-limiter';
import Decimal from 'decimal.js';
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
  TransactionEvent,
  WithUserCreds,
} from '../../core/types';
import { fetchWithTimeout } from '../../core/utils/fetch';

interface BlockchainInfoAddress {
  address: string;
  final_balance: number;
  n_tx: number;
  total_received: number;
}

interface BlockchainInfoTxOutput {
  addr?: string;
  value: number;
}

interface BlockchainInfoTxInput {
  prev_out?: {
    addr?: string;
    value: number;
  };
}

interface BlockchainInfoTx {
  hash: string;
  time: number;
  inputs: BlockchainInfoTxInput[];
  out: BlockchainInfoTxOutput[];
}

interface BlockchainInfoAddressFull extends BlockchainInfoAddress {
  txs: BlockchainInfoTx[];
}

const BTC_INSTITUTION_CODE = 'bitcoin';
const BTC_DECIMALS = 8;
const SATOSHIS_PER_BTC = 100_000_000;
const TX_PAGE_SIZE = 50;

export class BitcoinProvider
  implements BalanceProvider, TransactionsProvider, AddressValidatorProvider
{
  readonly providerKey = 'bitcoin';
  readonly capabilities: readonly Capability[] = [
    'current-balances',
    'transactions',
    'address-validator',
  ];

  private readonly logger: CustomLogger;

  constructor(private readonly limiter: OutflowRateLimiter) {
    this.logger = createComponentLogger('provider:bitcoin');
  }

  canFetchBalances(institutionCode: string): boolean {
    return institutionCode === BTC_INSTITUTION_CODE;
  }

  canFetchTransactions(institutionCode: string): boolean {
    return institutionCode === BTC_INSTITUTION_CODE;
  }

  canValidate(institutionCode: string): boolean {
    return institutionCode === BTC_INSTITUTION_CODE;
  }

  /**
   * Validate a Bitcoin address. Used by integration setup paths to
   * fail-fast on malformed input. Covers the three canonical formats
   * — P2PKH (`1...`), P2SH (`3...`), Bech32 (`bc1...`). Doesn't
   * checksum-validate; the API call below will reject malformed
   * addresses cheaply if they slip through.
   *
   * The `_institutionCode` param satisfies `AddressValidatorProvider`
   * so the discovery service can call without knowing which provider
   * it has — but we ignore it here because BitcoinProvider only ever
   * claims one institution code.
   */
  isValidAddress(address: string, _institutionCode?: string): boolean {
    if (/^1[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) return true;
    if (/^3[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) return true;
    if (/^bc1[a-z0-9]{39,59}$/.test(address)) return true;
    return false;
  }

  /**
   * Lightweight existence probe for `WalletDiscoveryService.detectWalletChains`.
   * `n_tx > 0` from blockchain.info's `/rawaddr` covers both incoming
   * and outgoing. Cheap (one HTTP call), shares the bitcoin rate limiter.
   */
  async hasActivity(
    address: string,
    _institutionCode: string,
    _ctx: ProviderContext
  ): Promise<boolean> {
    if (!this.isValidAddress(address)) return false;
    try {
      const url = `https://blockchain.info/rawaddr/${address}?limit=0`;
      const response = await this.limiter.execute(async () => fetchWithTimeout(url));
      if (!response.ok) return false;
      const data = (await response.json()) as { n_tx?: number };
      return typeof data.n_tx === 'number' && data.n_tx > 0;
    } catch (err) {
      this.logger.debug(
        { address: `${address.substring(0, 10)}...`, error: err },
        'Bitcoin hasActivity probe failed; treating as no activity'
      );
      return false;
    }
  }

  async fetchBalances(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<HoldingSnapshot[]> {
    const creds = await ctx.resolveCredentials(ctx.credentialsRef);
    const address =
      (creds.walletAddress as string | undefined) ?? (creds.address as string | undefined);
    if (!address || !this.isValidAddress(address)) {
      this.logger.warn(
        { providerKey: this.providerKey, hasAddress: Boolean(address) },
        'Bitcoin balance fetch: invalid or missing address'
      );
      return [];
    }

    const url = `https://blockchain.info/rawaddr/${address}`;
    const response = await this.limiter.execute(async () => fetchWithTimeout(url));
    if (!response.ok) {
      throw new Error(`blockchain.info: HTTP ${response.status} for ${address}`);
    }
    const data = (await response.json()) as BlockchainInfoAddress;
    const balanceSatoshis = new Decimal(data.final_balance);
    const balanceBTC = balanceSatoshis.div(SATOSHIS_PER_BTC);
    if (balanceBTC.isZero()) return [];

    const tokenIdentity: Partial<NewToken> = {
      symbol: 'BTC',
      name: 'Bitcoin',
      decimals: BTC_DECIMALS,
      providerMetadata: {},
    };

    return [
      {
        externalId: 'native',
        tokenIdentity,
        balance: balanceBTC.toString(),
        capturedAt: new Date(),
      },
    ];
  }

  async fetchTransactions(
    ctx: WithUserCreds<ProviderContext> & {
      institutionCode: string;
      since?: Date;
      until?: Date;
    }
  ): Promise<TransactionEvent[]> {
    const creds = await ctx.resolveCredentials(ctx.credentialsRef);
    const address =
      (creds.walletAddress as string | undefined) ?? (creds.address as string | undefined);
    if (!address || !this.isValidAddress(address)) {
      this.logger.warn(
        { providerKey: this.providerKey, hasAddress: Boolean(address) },
        'Bitcoin transactions fetch: invalid or missing address'
      );
      return [];
    }

    const events: TransactionEvent[] = [];
    let offset = 0;
    while (true) {
      const url = `https://blockchain.info/rawaddr/${address}?limit=${TX_PAGE_SIZE}&offset=${offset}`;
      const response = await this.limiter.execute(async () => fetchWithTimeout(url));
      if (!response.ok) {
        throw new Error(`blockchain.info: HTTP ${response.status} for ${address}`);
      }
      const data = (await response.json()) as BlockchainInfoAddressFull;
      const txs = data.txs ?? [];
      for (const tx of txs) {
        const event = this.toTransactionEvent(tx, address);
        if (event) events.push(event);
      }
      if (txs.length < TX_PAGE_SIZE) break;
      offset += TX_PAGE_SIZE;
    }

    return events.filter((e) => {
      if (ctx.since && e.occurredAt < ctx.since) return false;
      if (ctx.until && e.occurredAt > ctx.until) return false;
      return true;
    });
  }

  private toTransactionEvent(tx: BlockchainInfoTx, wallet: string): TransactionEvent | null {
    let inflow = new Decimal(0);
    let outflow = new Decimal(0);
    for (const out of tx.out ?? []) {
      if (out.addr === wallet) inflow = inflow.plus(out.value);
    }
    for (const input of tx.inputs ?? []) {
      if (input.prev_out?.addr === wallet) outflow = outflow.plus(input.prev_out.value);
    }
    const netSatoshis = inflow.minus(outflow);
    if (netSatoshis.isZero()) return null;
    const netBtc = netSatoshis.div(SATOSHIS_PER_BTC);
    const tokenIdentity: Partial<NewToken> = {
      symbol: 'BTC',
      name: 'Bitcoin',
      decimals: BTC_DECIMALS,
    };
    return {
      externalId: tx.hash,
      occurredAt: new Date(tx.time * 1000),
      kind: netBtc.gt(0) ? 'transfer_in' : 'transfer_out',
      primary: { tokenIdentity, quantity: netBtc.toString() },
    };
  }
}

export const bitcoinFactory: ProviderFactory = async (deps) => {
  // blockchain.info has no documented public limit but is conservative
  // about sustained traffic; 5 req/s keeps us out of trouble.
  const limiter = createOutflowLimiter({
    maxRequests: 5,
    windowMs: 1000,
    redis: deps.redis ?? undefined,
    namespace: 'bitcoin',
  });
  const registered = deps.rateLimiterRegistry.register({
    namespace: 'bitcoin',
    limiter,
    registeredFrom: 'providers/bitcoin',
    description: 'blockchain.info: 5 req / 1s',
  });
  return new BitcoinProvider(registered);
};

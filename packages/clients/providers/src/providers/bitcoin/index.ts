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

/**
 * How far a later page's timestamps may run AHEAD of the page before it.
 *
 * `/rawaddr` pages by block height, newest block first — but `time` is
 * the block's own stamp, and consensus only requires it to beat the
 * median of the previous eleven blocks while allowing up to two hours
 * ahead of network time. So a lower block can legitimately carry a newer
 * stamp than the block above it. Measured against the genesis address on
 * 2026-08-17: one inversion in a 50-tx page, 1h48m at its widest.
 *
 * The `since` walk below therefore stops a margin PAST the cutoff rather
 * than at it. Stopping at the cutoff would drop a transaction whose stamp
 * sits just inside the window but whose block sits just outside the page,
 * and dropping it is silent — the ledger simply never learns of it.
 */
const BLOCK_TIME_SKEW_MS = 2 * 60 * 60 * 1000;

/**
 * Structural check for the three canonical Bitcoin address formats —
 * P2PKH (`1…`), P2SH (`3…`), Bech32 (`bc1…`). Pure and offline; the
 * chain-stub provider reuses it so a stubbed boot answers address
 * shape exactly as the live one does.
 */
export function isBitcoinAddress(address: string): boolean {
  if (/^1[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) return true;
  if (/^3[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) return true;
  if (/^bc1[a-z0-9]{39,59}$/.test(address)) return true;
  return false;
}

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
    return isBitcoinAddress(address);
  }

  /**
   * Lightweight existence probe for `WalletDiscoveryService.detectWalletChains`.
   * `n_tx > 0` from blockchain.info's `/rawaddr` covers both incoming
   * and outgoing. Cheap (one HTTP call), shares the bitcoin rate limiter.
   *
   * Throws when the probe could not be completed. blockchain.info answers
   * a burst with a 429 that lasts 40+ minutes (SC-364), and swallowing it
   * reported the wallet as having no Bitcoin history — indistinguishable
   * from a real regression (SC-490).
   */
  async hasActivity(
    address: string,
    _institutionCode: string,
    _ctx: ProviderContext
  ): Promise<boolean> {
    if (!this.isValidAddress(address)) return false;
    const url = `https://blockchain.info/rawaddr/${address}?limit=0`;
    const response = await this.limiter.execute(async () => fetchWithTimeout(url));
    if (!response.ok) {
      throw new Error(`blockchain.info: HTTP ${response.status} for ${address}`);
    }
    const data = (await response.json()) as { n_tx?: number };
    return typeof data.n_tx === 'number' && data.n_tx > 0;
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

  /**
   * Transactions for a Bitcoin address. Pages `/rawaddr` on an offset
   * cursor, summing each tx's outputs to the wallet against its inputs
   * from the wallet to get one signed net delta per tx.
   *
   * `since` stops the walk. blockchain.info pages newest-block-first, so
   * once a page runs older than the cutoff (plus `BLOCK_TIME_SKEW_MS`,
   * which is what makes that comparison safe) every later page is older
   * still and every event on it would be dropped by the filter below —
   * which stays, because a page straddling the cutoff carries events on
   * both sides of it. Same shape as the Helius fix in SC-360; without it
   * the nightly 30-day sync re-walked the wallet's whole history every
   * night.
   *
   * One event per tx, keyed on the tx hash, is also what keeps the
   * ledger's `(holding, source, external_id)` key unique: a tx paying
   * several outputs to the same wallet is one net delta here, not
   * several rows racing for one key.
   */
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
      if (ctx.since) {
        const oldestOnPage = Math.min(...txs.map((tx) => tx.time)) * 1000;
        if (oldestOnPage < ctx.since.getTime() - BLOCK_TIME_SKEW_MS) break;
      }
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
  // 1 req/s, not the 5 this used to claim "keeps us out of trouble".
  //
  // Measured 2026-08-17 (SC-364): ONE burst of ~27 calls inside ~90s
  // earned a 429 whose body is the literal string "Rate limited", and it
  // was still 429 on all 13 probes over the NEXT 40 MINUTES. So this is
  // not a per-second throttle that recovers in a moment — it is a
  // long-window budget with a long penalty, and 5/s only spent that
  // budget faster.
  //
  // Which means 1/s lowers the rate we spend the budget at and does NOT
  // remove the exposure. The run that is exposed is a COLD full-history
  // import: no `since`, so `ceil(n_tx / 50)` requests back to back.
  // `fetchTransactions` throws on a non-ok response and the retry starts
  // again from offset 0, so a large wallet's first import can fail the
  // same way every attempt. Resumable paging or a 429-aware backoff is
  // the real fix if that ever bites; this is the cheap half.
  const limiter = createOutflowLimiter({
    maxRequests: 1,
    windowMs: 1000,
    redis: deps.redis ?? undefined,
    namespace: 'bitcoin',
  });
  const registered = deps.rateLimiterRegistry.register({
    namespace: 'bitcoin',
    limiter,
    registeredFrom: 'providers/bitcoin',
    description: 'blockchain.info: 1 req / 1s',
  });
  return new BitcoinProvider(registered);
};

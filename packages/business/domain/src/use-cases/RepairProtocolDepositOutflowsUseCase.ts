import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { answerSourceOf } from '@scani/shared';
import Decimal from 'decimal.js';
import { eq } from 'drizzle-orm';
import Container, { Service } from 'typedi';
import { TransferReviewService } from '../services/TransferReviewService';

/**
 * A protocol entrypoint that takes native currency and hands back a receipt the
 * SENDER still owns.
 *
 * Keyed on `methodId` — the 4-byte selector, which is what the chain actually
 * dispatched on — rather than on `functionName`, which is Etherscan's ABI
 * decode and is absent on any contract it has no ABI for. The contract address
 * is paired with a chain id because an address means nothing without one: the
 * same twenty bytes on Base are a different contract, and `0xd0e30db0` is the
 * selector of every `deposit()` ever written.
 */
interface ProtocolDeposit {
  protocol: 'weth9-wrap' | 'aave-v2-weth-gateway';
  chainId: string;
  contract: string;
  methodId: string;
  /**
   * Who the receipt is minted to, read out of the calldata, or `null` when the
   * contract can only ever mint to `msg.sender`.
   *
   * This is the whole claim, so it is checked rather than assumed: Aave's
   * `depositETH` takes an `onBehalfOf`, and a deposit made on behalf of someone
   * else IS a disposal. WETH9's `deposit()` takes no arguments and credits
   * `msg.sender` unconditionally, so there is nothing to read.
   */
  beneficiaryWordIndex: number | null;
}

/**
 * The registry. Two entries, both on Ethereum mainnet, both measured in
 * production 2026-08-18 (SC-377).
 *
 * It is deliberately a registry of CONTRACTS and not a list of transaction
 * ids: a row is repaired because of what it called, so the next wrap this
 * wallet makes is covered without editing anything.
 */
const PROTOCOL_DEPOSITS: ReadonlyArray<ProtocolDeposit> = [
  {
    protocol: 'weth9-wrap',
    chainId: '1',
    contract: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    methodId: '0xd0e30db0',
    beneficiaryWordIndex: null,
  },
  {
    protocol: 'aave-v2-weth-gateway',
    chainId: '1',
    contract: '0xcc9a0b7c43dc2a5f023bb9b738e45b0ef6b06e04',
    methodId: '0x474cf53d',
    beneficiaryWordIndex: 1,
  },
];

/** What to do about one outflow into a protocol deposit entrypoint. */
export interface ProtocolDepositPlan {
  transactionId: string;
  userId: string;
  symbol: string;
  /** Absolute, so the amount reads as the amount that moved. */
  quantity: string;
  occurredAt: Date;
  holdingId: string;
  accountName: string;
  protocol: ProtocolDeposit['protocol'];
  /** The selector the chain dispatched on — the evidence, restated. */
  methodId: string;
  action: 'untracked' | 'blocked';
  blockedReason: string | null;
}

/**
 * Stop booking a disposal on the two outflows that deposit ETH into a contract
 * which hands it straight back as a position the same wallet owns (SC-377).
 *
 * **What is wrong today.** Both rows carry `left_control`, and
 * `isConfirmedDisposal` is `left_control` alone, so `CostBasisService` prices
 * them at market and realizes a gain. Neither is a sale:
 *
 *   * `0xc02aaa39…` `deposit()` is WETH9. ETH in, WETH out, one for one, to
 *     `msg.sender`. It is the same asset in a different wrapper.
 *   * `0xcc9a0b7c…` `depositETH(lendingPool, onBehalfOf, referralCode)` is the
 *     Aave v2 WETHGateway. It wraps and supplies, and mints aWETH to
 *     `onBehalfOf` — which the calldata of the production row names as the
 *     sending wallet itself.
 *
 * **Why the answer is `untracked` and not `paired` or `internal`.** Both of
 * those write a `transfer_group_id` and carry the lots across, which is the
 * better arithmetic — and neither can express what happened here, for reasons
 * that are structural rather than incidental:
 *
 *   * `paired` claims an inflow the ledger already holds. For the wrap there
 *     is none and there never will be: WETH9's `deposit()` emits `Deposit`,
 *     not `Transfer`, so an ERC-20 transfer feed cannot see a wrap at all.
 *     Production agrees — the wrap's hash has exactly one row, the ETH leg.
 *   * `internal` writes the arrival, but `writeInflow` binds it to
 *     `outflow.tokenId`. It can only ever move ETH to another ETH holding, so
 *     it cannot say "this became WETH", and `listDestinations` will not offer
 *     the WETH holding for the same reason.
 *
 * So `untracked` — "still the user's, in a place Scani holds no row for" — is
 * the one available answer that is true, and it is true in the strict sense:
 * Scani holds no row for the 0.02 WETH or for the aWETH. It books nothing,
 * writes nothing, and invents no counterparty. What it does NOT do is carry
 * the cost basis into the receipt token; that needs the wrap modelled as a
 * conversion, which is a larger change than this repair.
 *
 * **Why a use case and not a script**, the reason `RepairMatchedOutflows` and
 * `RepairOwnWalletDisposals` both give: the derivation is the part that can be
 * wrong about money, so it is a service method with tests around it and the
 * script is a printer.
 */
@Service()
export class RepairProtocolDepositOutflowsUseCase {
  private readonly reviewService = Container.get(TransferReviewService);

  /**
   * Every outflow that called one of the registered entrypoints, and what the
   * evidence says to do about each.
   *
   * The population is derived from the ledger, never passed in. A caller that
   * knows which ids it expects passes them as an assertion — see
   * `scripts/repair-sc377-protocol-deposits.ts`.
   */
  async plansFor(userId: string): Promise<ProtocolDepositPlan[]> {
    const rows = await db
      .select({
        tx: schema.holdingTransactions,
        symbol: schema.tokens.symbol,
        accountName: schema.accounts.name,
        accountMetadata: schema.accounts.metadata,
      })
      .from(schema.holdingTransactions)
      .innerJoin(schema.tokens, eq(schema.tokens.id, schema.holdingTransactions.tokenId))
      .innerJoin(schema.holdings, eq(schema.holdings.id, schema.holdingTransactions.holdingId))
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.holdings.accountId))
      .where(eq(schema.holdingTransactions.userId, userId));

    const plans: ProtocolDepositPlan[] = [];
    for (const row of rows) {
      const payload = payloadOf(row.tx.rawPayload);
      if (payload === null) continue;
      const entry = PROTOCOL_DEPOSITS.find(
        (d) =>
          d.contract === lower(payload.to) &&
          d.methodId === lower(payload.methodId) &&
          d.chainId === chainIdOf(row.accountMetadata)
      );
      if (!entry) continue;

      plans.push({
        transactionId: row.tx.id,
        userId,
        symbol: row.symbol,
        quantity: new Decimal(row.tx.quantity).abs().toString(),
        occurredAt: row.tx.occurredAt,
        holdingId: row.tx.holdingId,
        accountName: row.accountName,
        protocol: entry.protocol,
        methodId: entry.methodId,
        ...verdict(entry, row.tx, payload),
      });
    }
    return plans.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }

  /**
   * Write one plan. `reopen` then `resolve`, and never around them: the
   * timestamp, the attribution and the cleanup of anything a previous answer
   * created stay `TransferReviewService`'s business rather than this file's.
   *
   * Throws rather than returning a result. A repair applies a plan that was
   * printed and read first, so a refusal here means the world changed under it.
   */
  async apply(plan: ProtocolDepositPlan): Promise<void> {
    if (plan.action === 'blocked') {
      throw new Error(
        `${plan.transactionId}: refusing to apply a blocked plan — ${plan.blockedReason}`
      );
    }
    const reopened = await this.reviewService.reopen(plan.userId, plan.transactionId);
    if (!reopened) throw new Error(`${plan.transactionId}: reopen returned false`);

    const result = await this.reviewService.resolve(plan.userId, plan.transactionId, 'untracked', {
      answerSource: 'repair',
    });
    if (!result.ok) {
      throw new Error(`${plan.transactionId}: resolve('untracked') failed — ${result.reason}`);
    }
  }
}

/**
 * The refusals, in the order the evidence narrows them.
 *
 * Every one of these is a `blocked` rather than a skip, because a row that
 * called a registered entrypoint and is NOT repaired is exactly what a reader
 * needs to see before running `--commit`.
 */
function verdict(
  entry: ProtocolDeposit,
  tx: typeof schema.holdingTransactions.$inferSelect,
  payload: EvmPayload
): Pick<ProtocolDepositPlan, 'action' | 'blockedReason'> {
  const blocked = (why: string) => ({ action: 'blocked' as const, blockedReason: why });

  // Only rows that book a disposal TODAY. Anything else is either already
  // correct or carries an answer this repair has no mandate to rewrite.
  if (tx.transferReview !== 'left_control') {
    return blocked(`answer is '${tx.transferReview ?? 'unanswered'}', not 'left_control'`);
  }
  // A person decided this. SC-377 covers the residue of the 2026-08-14 raw
  // UPDATE, and overruling a human answer is a different act needing a
  // different mandate. `answerSourceOf` rather than a local reading of the two
  // columns, so this refusal and the queue's own attribution can never drift
  // apart (SC-350).
  if (answerSourceOf(tx) === 'user') {
    return blocked('answered by a person — this repair does not overrule a stamped answer');
  }
  if (tx.transferGroupId !== null) {
    return blocked(`already carries transfer_group_id ${tx.transferGroupId}`);
  }
  if (tx.transferReviewSplit !== null) {
    return blocked('carries a split answer, which this repair cannot rewrite in part');
  }
  if (!new Decimal(tx.quantity).isNegative()) {
    return blocked('quantity is not negative — this is not an outflow');
  }
  // An ERC-20 leg of the same transaction carries the token contract here. The
  // claim is about the NATIVE currency the call was paid with, and a token leg
  // reaching this point would mean the registry matched the wrong row.
  if (payload.contractAddress !== '') {
    return blocked(`raw_payload names token contract ${payload.contractAddress} — not native`);
  }
  // A reverted call returns the ETH, so the value never left and there is
  // nothing to repair. `isError` and `txreceipt_status` disagree on some
  // Etherscan responses; requiring both is cheaper than deciding which wins.
  if (payload.isError !== '0' || payload.txreceiptStatus !== '1') {
    return blocked(
      `call did not succeed (isError=${payload.isError}, txreceipt_status=${payload.txreceiptStatus})`
    );
  }
  // The amount the contract received has to be the amount the row says left,
  // or the row is not describing this call.
  const wei = weiOf(tx.quantity);
  if (wei === null || wei !== payload.value) {
    return blocked(`raw_payload.value ${payload.value} does not match quantity ${tx.quantity} wei`);
  }

  if (entry.beneficiaryWordIndex !== null) {
    const beneficiary = addressArg(payload.input, entry.beneficiaryWordIndex);
    if (beneficiary === null) {
      return blocked(`calldata too short to read argument ${entry.beneficiaryWordIndex}`);
    }
    // The whole claim in one comparison. A deposit made on behalf of somebody
    // else genuinely disposes of the ETH, and `left_control` would be right
    // about it.
    if (beneficiary !== lower(payload.from)) {
      return blocked(`receipt goes to ${beneficiary}, not to the sender ${lower(payload.from)}`);
    }
  }

  return { action: 'untracked', blockedReason: null };
}

interface EvmPayload {
  to: string;
  from: string;
  input: string;
  value: string;
  methodId: string;
  isError: string;
  txreceiptStatus: string;
  contractAddress: string;
}

function payloadOf(raw: unknown): EvmPayload | null {
  const p = raw as Record<string, unknown> | null;
  if (!p || typeof p.to !== 'string' || typeof p.methodId !== 'string') return null;
  return {
    to: p.to,
    from: str(p.from),
    input: str(p.input),
    value: str(p.value),
    methodId: p.methodId,
    isError: str(p.isError),
    txreceiptStatus: str(p.txreceipt_status),
    contractAddress: str(p.contractAddress),
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function lower(v: string): string {
  return v.trim().toLowerCase();
}

function chainIdOf(metadata: unknown): string | null {
  const raw = (metadata as { chainId?: unknown } | null)?.chainId;
  if (typeof raw === 'number') return String(raw);
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  return null;
}

/**
 * A decimal ETH amount as an exact wei integer string, or `null` when it is not
 * one.
 *
 * `Decimal` rather than `BigInt(parseEther(...))` because the repo already
 * configures a Decimal with enough precision and 18 decimals of ETH is beyond
 * a float. A quantity with more than 18 decimals is not a wei amount and is
 * refused rather than rounded — rounding here would let a row match a call it
 * does not describe.
 */
function weiOf(quantity: string): string | null {
  const scaled = new Decimal(quantity).abs().mul(new Decimal(10).pow(18));
  return scaled.isInteger() ? scaled.toFixed(0) : null;
}

/** The n-th 32-byte word of calldata read as an address, lowercased. */
function addressArg(input: string, wordIndex: number): string | null {
  const args = input.startsWith('0x') ? input.slice(10) : input.slice(8);
  const start = wordIndex * 64;
  const word = args.slice(start, start + 64);
  if (word.length !== 64) return null;
  return `0x${word.slice(24)}`.toLowerCase();
}

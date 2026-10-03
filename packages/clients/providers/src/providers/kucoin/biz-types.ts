import type { TransactionEvent } from '../../core/types';

export type KucoinTransactionKind = TransactionEvent['kind'];

const normalize = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '_');

const FIXED: Record<string, KucoinTransactionKind> = {
  deposit: 'deposit',
  withdrawal: 'withdraw',
  withdraw: 'withdraw',
  rebate: 'reward',
  distribution: 'reward',
  kucoin_bonus: 'reward',
  reward: 'reward',
  staking: 'interest',
  staking_rewards: 'interest',
  soft_staking: 'interest',
  interest: 'interest',
};

const DIRECTIONAL: Record<
  string,
  { inflow: KucoinTransactionKind; outflow: KucoinTransactionKind }
> = {
  exchange: { inflow: 'buy', outflow: 'sell' },
  trade_exchange: { inflow: 'buy', outflow: 'sell' },
  spot_trading: { inflow: 'buy', outflow: 'sell' },
  sub_account_transfer: { inflow: 'transfer_in', outflow: 'transfer_out' },
  sub_transfer: { inflow: 'transfer_in', outflow: 'transfer_out' },
  main_transfer: { inflow: 'transfer_in', outflow: 'transfer_out' },
  inner_transfer: { inflow: 'transfer_in', outflow: 'transfer_out' },
  transfer: { inflow: 'transfer_in', outflow: 'transfer_out' },
  convert_to_kcs: { inflow: 'swap_in', outflow: 'swap_out' },
};

export function mapKucoinBizType(bizType: string, isInflow: boolean): KucoinTransactionKind {
  const key = normalize(bizType);
  const fixed = FIXED[key];
  if (fixed) return fixed;
  const dir = DIRECTIONAL[key];
  if (dir) return isInflow ? dir.inflow : dir.outflow;
  return 'unknown';
}

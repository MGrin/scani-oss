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
  { positive: KucoinTransactionKind; negative: KucoinTransactionKind }
> = {
  exchange: { positive: 'buy', negative: 'sell' },
  trade_exchange: { positive: 'buy', negative: 'sell' },
  spot_trading: { positive: 'buy', negative: 'sell' },
  sub_account_transfer: { positive: 'transfer_in', negative: 'transfer_out' },
  main_transfer: { positive: 'transfer_in', negative: 'transfer_out' },
  inner_transfer: { positive: 'transfer_in', negative: 'transfer_out' },
  transfer: { positive: 'transfer_in', negative: 'transfer_out' },
  convert_to_kcs: { positive: 'swap_in', negative: 'swap_out' },
};

export function mapKucoinBizType(
  bizType: string,
  amountIsPositive: boolean
): KucoinTransactionKind {
  const key = normalize(bizType);
  const fixed = FIXED[key];
  if (fixed) return fixed;
  const dir = DIRECTIONAL[key];
  if (dir) return amountIsPositive ? dir.positive : dir.negative;
  return 'unknown';
}

import type { NewToken } from '@scani/db/schema';
import type { TransactionEvent } from '../../core/types';

export interface OkxTransfer {
  ccy: string;
  chain?: string;
  amt: string;
  ts: string;
  txId?: string;
  state?: string;
  depId?: string;
  wdId?: string;
  from?: string;
  to?: string;
  fee?: string;
}

export interface OkxTransfersResponse {
  code: string;
  msg: string;
  data: OkxTransfer[];
}

function tokenIdentity(ccy: string): Partial<NewToken> {
  const upper = ccy.toUpperCase();
  return {
    symbol: upper,
    name: upper,
    providerMetadata: { okx: { ccy: upper } },
  };
}

export function mapOkxDepositToEvent(t: OkxTransfer): TransactionEvent | null {
  if (!t.depId) return null;
  return {
    externalId: `dep:${t.depId}`,
    occurredAt: new Date(Number(t.ts)),
    kind: 'deposit',
    primary: { tokenIdentity: tokenIdentity(t.ccy), quantity: t.amt },
    rawPayload: t,
  };
}

export function mapOkxWithdrawalToEvent(t: OkxTransfer): TransactionEvent | null {
  if (!t.wdId) return null;
  const event: TransactionEvent = {
    externalId: `wd:${t.wdId}`,
    occurredAt: new Date(Number(t.ts)),
    kind: 'withdraw',
    primary: {
      tokenIdentity: tokenIdentity(t.ccy),
      // OKX withdrawals report `amt` as a positive number; sign it
      // negative to satisfy the outflow convention on TransactionEvent.
      quantity: t.amt.startsWith('-') ? t.amt : `-${t.amt}`,
    },
    rawPayload: t,
  };
  const feeNum = t.fee ? Number(t.fee) : 0;
  if (feeNum > 0) {
    event.fee = {
      tokenIdentity: tokenIdentity(t.ccy),
      quantity: `-${t.fee}`,
    };
  }
  return event;
}

import type { NewToken } from '@scani/db/schema';
import type { TransactionEvent } from '../../core/types';

export interface OkxBill {
  billId: string;
  ts: string;
  ccy: string;
  type: string;
  subType: string;
  balChg: string;
  bal?: string;
  fee?: string;
  feeCcy?: string;
  instType?: string;
  instId?: string;
  px?: string;
}

export interface OkxBillsResponse {
  code: string;
  msg: string;
  data: OkxBill[];
}

function tokenIdentity(ccy: string): Partial<NewToken> {
  const upper = ccy.toUpperCase();
  return {
    symbol: upper,
    name: upper,
    providerMetadata: { okx: { ccy: upper } },
  };
}

function parsePair(instId: string | undefined): { base: string; quote: string } | null {
  if (!instId) return null;
  const parts = instId.split('-');
  if (parts.length < 2) return null;
  const [base, quote] = parts;
  if (!base || !quote) return null;
  return { base, quote };
}

/**
 * Convert one OKX bill row to a `TransactionEvent`. Returns null for
 * bill types that don't carry a meaningful holding-level event (e.g.
 * pure margin moves between sub-accounts that net to zero).
 *
 * Only types this provider emits from the unified bills feed:
 *  - type 2 (Trade) → buy / sell decided by `balChg` sign.
 *  - type 8 (Funding fee) → fee event in the row's currency.
 *  - type 1 (Transfer) + subType 1/2 → deposit / withdraw, but emitted
 *    by `transfer-mapper` against the dedicated /asset endpoints
 *    instead so we capture the on-chain txId. Kept here for
 *    completeness so a caller that only sees bills (e.g. the bill
 *    mapping unit test) gets a sensible event.
 */
export function mapOkxBillToEvent(bill: OkxBill): TransactionEvent | null {
  const occurredAt = new Date(Number(bill.ts));
  const balChg = bill.balChg ?? '0';
  const positive = !balChg.startsWith('-') && balChg !== '0';
  const base: Pick<TransactionEvent, 'externalId' | 'occurredAt' | 'rawPayload'> = {
    externalId: bill.billId,
    occurredAt,
    rawPayload: bill,
  };

  switch (bill.type) {
    case '2': {
      const pair = parsePair(bill.instId);
      const event: TransactionEvent = {
        ...base,
        kind: positive ? 'buy' : 'sell',
        primary: { tokenIdentity: tokenIdentity(bill.ccy), quantity: balChg },
      };
      if (pair) {
        const counterCcy =
          bill.ccy.toUpperCase() === pair.base.toUpperCase() ? pair.quote : pair.base;
        event.counter = { tokenIdentity: tokenIdentity(counterCcy), quantity: '0' };
      }
      const feeNum = bill.fee ? Number(bill.fee) : 0;
      if (feeNum !== 0 && bill.feeCcy) {
        event.fee = {
          tokenIdentity: tokenIdentity(bill.feeCcy),
          quantity: feeNum < 0 ? bill.fee! : `-${bill.fee}`,
        };
      }
      if (bill.px) {
        const pair2 = parsePair(bill.instId);
        if (pair2) {
          event.priceNative = {
            value: bill.px,
            quoteIdentity: tokenIdentity(pair2.quote),
          };
        }
      }
      return event;
    }
    case '8': {
      return {
        ...base,
        kind: 'fee',
        primary: { tokenIdentity: tokenIdentity(bill.ccy), quantity: balChg },
      };
    }
    case '1': {
      // Transfer. subType 1 = deposit, 2 = withdraw (per OKX docs).
      const kind = bill.subType === '1' ? 'deposit' : bill.subType === '2' ? 'withdraw' : 'unknown';
      return {
        ...base,
        kind,
        primary: { tokenIdentity: tokenIdentity(bill.ccy), quantity: balChg },
      };
    }
    default:
      return null;
  }
}

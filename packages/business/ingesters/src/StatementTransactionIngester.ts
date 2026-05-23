import type { NewHoldingBalanceObservation, NewHoldingTransaction } from '@scani/db/schema';
import type { ParsedTransaction, ParseResult } from '@scani/file-import';
import { createComponentLogger } from '@scani/logging';
import Decimal from 'decimal.js';
import { Service } from 'typedi';

export interface StatementResolveTokenFn {
  // Caller-owned lookup so the ingester stays decoupled from
  // TokenService/HoldingService — keeps the package leaf-free of
  // @scani/domain. Implementations should find-or-create the holding
  // for (userId, accountId, tokenId) so statements for already-closed
  // accounts still attribute to a real holding row.
  resolveFiatTokenBySymbol(symbol: string): Promise<{ holdingId: string; tokenId: string } | null>;
}

export interface StatementIngesterInput {
  userId: string;
  accountId: string;
  parseResult: ParseResult;
  resolveToken: StatementResolveTokenFn;
  defaultCurrency?: string;
}

export interface StatementIngesterResult {
  transactions: NewHoldingTransaction[];
  observations: NewHoldingBalanceObservation[];
  warnings: string[];
  firstEventAt: Date | null;
  lastEventAt: Date | null;
}

@Service()
export class StatementTransactionIngester {
  private readonly logger = createComponentLogger('ingester:statement');

  readonly source = 'statement';

  async ingest(input: StatementIngesterInput): Promise<StatementIngesterResult> {
    const { parseResult } = input;
    const warnings = [...parseResult.warnings];
    const transactions: NewHoldingTransaction[] = [];
    const observations: NewHoldingBalanceObservation[] = [];
    const accumulator: { first: Date | null; last: Date | null } = { first: null, last: null };

    if (parseResult.transactions.length === 0) {
      return {
        transactions,
        observations,
        warnings,
        firstEventAt: null,
        lastEventAt: null,
      };
    }

    const tokenCache = new Map<string, { holdingId: string; tokenId: string }>();
    const resolveCurrency = async (
      symbol: string
    ): Promise<{ holdingId: string; tokenId: string } | null> => {
      const upper = symbol.trim().toUpperCase();
      if (!upper) return null;
      const cached = tokenCache.get(upper);
      if (cached) return cached;
      const r = await input.resolveToken.resolveFiatTokenBySymbol(upper);
      if (!r) {
        warnings.push(`Unknown currency '${upper}' — statement rows for this currency skipped`);
        return null;
      }
      tokenCache.set(upper, r);
      return r;
    };

    const sourceTag = `statement-${parseResult.format}`;

    // Row ordinals guarantee a deterministic external_id for formats
    // (CSV, QIF) that lack a natural one — keeps re-uploads idempotent
    // while distinguishing genuinely-different lines within one file.
    let ordinal = 0;

    for (const tx of parseResult.transactions) {
      ordinal += 1;
      const currencySymbol = (
        tx.currency ||
        input.defaultCurrency ||
        parseResult.detectedCurrency ||
        ''
      ).trim();
      if (!currencySymbol) {
        warnings.push(
          `Transaction without currency at ${tx.date.toISOString()} — skipped (consider setting defaultCurrency on the account)`
        );
        continue;
      }
      const resolved = await resolveCurrency(currencySymbol);
      if (!resolved) continue;

      // Bank-statement amounts are signed money flow (positive = credit,
      // negative = debit). Store as-is and derive `kind` from sign —
      // fiat rows have no "swap" concept.
      const amt = new Decimal(tx.amount);
      const kind = amt.isPositive() ? 'deposit' : amt.isNegative() ? 'withdraw' : 'unknown';

      const occurredAt = tx.date;
      if (!accumulator.first || occurredAt.getTime() < accumulator.first.getTime()) {
        accumulator.first = occurredAt;
      }
      if (!accumulator.last || occurredAt.getTime() > accumulator.last.getTime()) {
        accumulator.last = occurredAt;
      }

      const externalId = this.buildExternalId(tx, ordinal);

      transactions.push({
        userId: input.userId,
        holdingId: resolved.holdingId,
        tokenId: resolved.tokenId,
        kind,
        quantity: amt.toString(),
        occurredAt,
        externalId,
        source: sourceTag,
        sourceMetadata: {
          description: tx.description,
          bankTemplate: parseResult.bankTemplate ?? null,
          format: parseResult.format,
        },
        rawPayload: (tx.raw ?? null) as Record<string, unknown> | null,
      });
    }

    // Anchor balance-at-time at the statement's period end via a single
    // closing-balance observation. Intra-statement running balances are
    // ignored — one anchor per upload is enough.
    const sorted = [...parseResult.transactions].sort(
      (a, b) => a.date.getTime() - b.date.getTime()
    );
    const last = sorted[sorted.length - 1];
    if (last?.balance !== undefined && last.balance !== null) {
      const currency = (
        last.currency ||
        input.defaultCurrency ||
        parseResult.detectedCurrency ||
        ''
      )
        .trim()
        .toUpperCase();
      const resolved = currency
        ? (tokenCache.get(currency) ?? (await resolveCurrency(currency)))
        : null;
      if (resolved) {
        observations.push({
          userId: input.userId,
          holdingId: resolved.holdingId,
          balance: new Decimal(last.balance).toString(),
          observedAt: last.date,
          source: 'statement-close',
          sourceMetadata: {
            format: parseResult.format,
            bankTemplate: parseResult.bankTemplate ?? null,
          },
        });
      }
    }

    this.logger.info(
      {
        accountId: input.accountId,
        format: parseResult.format,
        transactionCount: transactions.length,
        observationCount: observations.length,
      },
      'Statement ingestion complete'
    );

    return {
      transactions,
      observations,
      warnings,
      firstEventAt: accumulator.first,
      lastEventAt: accumulator.last,
    };
  }

  // Prefer source-native ids (`raw.id` / `fitid` / `txid`) so identical
  // re-uploads dedup; synthesize from (date, amount, description, ordinal)
  // only when nothing natural exists.
  private buildExternalId(tx: ParsedTransaction, ordinal: number): string {
    const natural =
      tx.raw?.id ?? tx.raw?.fitid ?? tx.raw?.FITID ?? tx.raw?.txid ?? tx.raw?.transactionId;
    if (natural) return `natural:${natural}`;
    const desc = (tx.description || '').replace(/\s+/g, ' ').slice(0, 40);
    const date = tx.date.toISOString().slice(0, 19);
    return `synthetic:${date}:${tx.amount}:${desc}:${ordinal}`;
  }
}

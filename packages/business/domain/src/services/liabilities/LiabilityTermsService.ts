import type { DatabaseTransaction } from '@scani/db';
import { getDb } from '@scani/db/connection';
import type { LiabilityKind, LiabilityTerms } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import {
  type LiabilityProjectionDto,
  SetLiabilityTermsDto,
  type SetLiabilityTermsDto as SetLiabilityTermsInput,
} from '@scani/shared';
import Decimal from 'decimal.js';
import { and, eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import {
  cardUtilization,
  type LoanTerms,
  projectPayoff,
  schedule,
} from '../../lib/liabilities/amortization';
import { LiabilityTermsRepository } from '../../repositories/LiabilityTermsRepository';
import { localDate } from '../payments/PaymentReminderService';
import { AccountClassService } from './AccountClassService';

export class LiabilityAccountNotFound extends Error {
  constructor() {
    super('Liability account not found');
    this.name = 'LiabilityAccountNotFound';
  }
}

export class LiabilityTermsOnAssetAccount extends Error {
  constructor() {
    super('Loan and card terms belong on a liability account');
    this.name = 'LiabilityTermsOnAssetAccount';
  }
}

export class InvalidLiabilityTerms extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidLiabilityTerms';
  }
}

const DEFAULT_DECIMALS = 2;

/**
 * The user's calendar date at `now` (SC-1672). A projection run on the
 * server's UTC date reads a day off for anyone far from UTC. No timezone, or
 * one `Intl` refuses, falls back to UTC rather than failing the read.
 */
export function userToday(now: Date, timezone: string | null | undefined): string {
  if (timezone) {
    try {
      return localDate(now, timezone);
    } catch {
      // An unknown zone name throws a RangeError; UTC is the honest default.
    }
  }
  return now.toISOString().slice(0, 10);
}

@Service()
export class LiabilityTermsService {
  private readonly accountClass = Container.get(AccountClassService);
  private readonly repo = Container.get(LiabilityTermsRepository);

  async get(
    userId: string,
    accountId: string,
    tx?: DatabaseTransaction
  ): Promise<LiabilityTerms | null> {
    await this.requireLiability(userId, accountId, tx);
    return this.repo.findByAccount(accountId, tx);
  }

  async set(
    userId: string,
    accountId: string,
    input: SetLiabilityTermsInput,
    tx?: DatabaseTransaction,
    today: string = userToday(new Date(), null)
  ): Promise<LiabilityTerms> {
    await this.requireLiability(userId, accountId, tx);
    const parsed = SetLiabilityTermsDto.safeParse(input);
    if (!parsed.success) {
      throw new InvalidLiabilityTerms(parsed.error.issues[0]?.message ?? 'Invalid terms');
    }
    const t = parsed.data;
    if (t.startDate && t.startDate > today) {
      throw new InvalidLiabilityTerms('The start date cannot be in the future');
    }
    return this.repo.upsert(
      {
        accountId,
        kind: t.kind,
        annualRatePct: t.annualRatePct ?? null,
        termMonths: t.termMonths ?? null,
        startDate: t.startDate ?? null,
        originalPrincipal: t.originalPrincipal ?? null,
        contractedPayment: t.contractedPayment ?? null,
        creditLimit: t.creditLimit ?? null,
        minimumPayment: t.minimumPayment ?? null,
        annualFee: t.annualFee ?? null,
      },
      tx
    );
  }

  async projection(
    userId: string,
    accountId: string,
    asOf: string,
    tx?: DatabaseTransaction
  ): Promise<LiabilityProjectionDto> {
    await this.requireLiability(userId, accountId, tx);
    const [terms, debt, typeCode] = await Promise.all([
      this.repo.findByAccount(accountId, tx),
      this.readDebt(userId, accountId, tx),
      this.accountClass.typeCodeOf(userId, accountId, tx),
    ]);
    const loan = terms ? loanTermsOf(terms) : null;
    const rows = loan ? schedule(loan, debt.decimals) : null;
    const projected = loan ? projectPayoff(loan, debt.owed, asOf, debt.decimals) : null;
    const card =
      terms?.kind === 'credit_card'
        ? cardUtilization(debt.owed, terms.creditLimit ? new Decimal(terms.creditLimit) : null)
        : null;
    return {
      kind: terms?.kind ?? kindOfType(typeCode),
      hasTerms: terms !== null,
      owed: debt.owed.toString(),
      currency: debt.currency,
      schedule:
        rows?.map((r) => ({
          n: r.n,
          date: r.date,
          payment: r.payment.toString(),
          interest: r.interest.toString(),
          principal: r.principal.toString(),
          remaining: r.remaining.toString(),
        })) ?? null,
      projection: projected
        ? { ...projected, remainingInterest: projected.remainingInterest.toString() }
        : null,
      card: card
        ? {
            utilization: card.utilization?.toString() ?? null,
            available: card.available?.toString() ?? null,
          }
        : null,
    };
  }

  private async requireLiability(userId: string, accountId: string, tx?: DatabaseTransaction) {
    const accountClass = await this.accountClass.classOf(userId, accountId, tx);
    if (accountClass === null) throw new LiabilityAccountNotFound();
    if (accountClass !== 'liability') throw new LiabilityTermsOnAssetAccount();
  }

  /**
   * The debt is the account's visible fiat holding, stored negative. With more
   * than one currency on the account, the largest by base value is the
   * loan's (SC-1672): 50,000 yen is less than 1,000 pounds. Where no holding
   * has a base value yet, the raw balance decides. The others still count in
   * net worth through their own holdings.
   */
  private async readDebt(userId: string, accountId: string, tx?: DatabaseTransaction) {
    const rows = await (tx ?? getDb())
      .select({
        balance: schema.holdings.balance,
        valueBase: schema.holdings.valueBase,
        symbol: schema.tokens.symbol,
        decimals: schema.tokens.decimals,
        tokenId: schema.tokens.id,
      })
      .from(schema.holdings)
      .innerJoin(schema.tokens, eq(schema.holdings.tokenId, schema.tokens.id))
      .innerJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
      .where(
        and(
          eq(schema.holdings.accountId, accountId),
          eq(schema.holdings.userId, userId),
          eq(schema.holdings.isHidden, false),
          eq(schema.tokenTypes.code, 'fiat')
        )
      );
    const byValue = rows.every((r) => r.valueBase !== null);
    const size = (r: (typeof rows)[number]) =>
      new Decimal((byValue ? r.valueBase : r.balance) ?? 0).abs();
    const largest = [...rows].sort((a, b) => size(b).comparedTo(size(a)))[0];
    if (!largest) return { owed: new Decimal(0), currency: null, decimals: DEFAULT_DECIMALS };
    const balance = rows
      .filter((r) => r.tokenId === largest.tokenId)
      .reduce((sum, r) => sum.plus(r.balance), new Decimal(0));
    return {
      owed: Decimal.max(balance.negated(), 0),
      currency: largest.symbol,
      decimals: largest.decimals ?? DEFAULT_DECIMALS,
    };
  }
}

function kindOfType(typeCode: string | null): LiabilityKind {
  if (typeCode === 'credit_card') return 'credit_card';
  if (typeCode === 'loan' || typeCode === 'mortgage') return 'loan';
  return 'other';
}

function loanTermsOf(t: LiabilityTerms): LoanTerms | null {
  if (t.kind !== 'loan') return null;
  if (!t.annualRatePct || !t.termMonths || !t.startDate || !t.originalPrincipal) return null;
  return {
    principal: new Decimal(t.originalPrincipal),
    annualRatePct: new Decimal(t.annualRatePct),
    termMonths: t.termMonths,
    startDate: t.startDate,
    payment: t.contractedPayment ? new Decimal(t.contractedPayment) : undefined,
  };
}

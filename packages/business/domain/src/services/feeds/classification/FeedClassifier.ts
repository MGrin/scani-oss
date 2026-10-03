import type { DatabaseTransaction } from '@scani/db';
import { counterpartyFromPayload, Decimal, normalizeCounterparty } from '@scani/shared';
import { Container, Service } from 'typedi';
import { AccountRepository } from '../../../repositories/AccountRepository';
import { FeedMatchRuleRepository } from '../../../repositories/FeedMatchRuleRepository';
import { HoldingTransactionRepository } from '../../../repositories/HoldingTransactionRepository';
import { UserWalletRepository } from '../../../repositories/UserWalletRepository';
import { MirrorLegWriter } from './MirrorLegWriter';
import { decide } from './steps';

export interface ClassificationOutcome {
  /** Each leg written: the destination holding and the instant it is dated at. */
  mirrorLegs: Array<{ holdingId: string; at: Date }>;
  notices: string[];
}

/** `metadata.chainId` as `->> 'chainId'` reads it. */
function chainKeyOf(metadata: unknown): string | null {
  const chainId = (metadata as Record<string, unknown> | null)?.chainId;
  return chainId === undefined || chainId === null ? null : String(chainId);
}

/**
 * Classification steps 2 and 3 over the rows one batch wrote (D-8, D-10).
 */
@Service()
export class FeedClassifier {
  private readonly accounts = Container.get(AccountRepository);
  private readonly rules = Container.get(FeedMatchRuleRepository);
  private readonly wallets = Container.get(UserWalletRepository);
  private readonly ledger = Container.get(HoldingTransactionRepository);
  private readonly mirror = Container.get(MirrorLegWriter);

  /**
   * Run after the batch's rows are re-labelled. A verdict naming a destination
   * for an outflow writes its mirror leg where the destination may take one;
   * otherwise a verdict's kind is written on the row, by rule. A row a step has
   * decided is paired or rule-labelled from then on, so a replay finds nothing
   * to decide.
   */
  async classify(
    batch: { userId: string; inputId: string; accountId: string; rowIds: readonly string[] },
    tx: DatabaseTransaction
  ): Promise<ClassificationOutcome> {
    const outcome: ClassificationOutcome = { mirrorLegs: [], notices: [] };
    const { userId, inputId, accountId } = batch;
    const rules = await this.rules.findForInput(userId, inputId, tx);
    const ownWallets = await this.wallets.findOwnWalletAccounts(userId, tx);
    if (rules.length === 0 && ownWallets.length === 0) return outcome;
    const rows = await this.ledger.findUnclassified(userId, batch.rowIds, tx);
    if (rows.length === 0) return outcome;

    const chainKey = chainKeyOf(
      (await this.accounts.findByIdAndUser(accountId, userId, tx))?.metadata
    );
    // The counterparty the queue's own-wallet check reads: the column, else the payload.
    const counterparties = rows.map((row) =>
      counterpartyFromPayload(row.kind, row.rawPayload, row.counterparty)
    );
    const keys = rules.some((rule) => rule.matchField === 'counterparty')
      ? await this.rules.counterpartyKeys(
          counterparties.filter((c): c is string => c !== null),
          tx
        )
      : new Map<string, string | null>();

    const eligible = new Map<string, boolean>();
    const mayTakeLeg = async (destinationAccountId: string) => {
      if (!eligible.has(destinationAccountId)) {
        const destination = await this.mirror.eligibleDestination(userId, destinationAccountId, tx);
        eligible.set(destinationAccountId, destination !== null);
      }
      return eligible.get(destinationAccountId) === true;
    };

    for (const [i, row] of rows.entries()) {
      const counterparty = counterparties[i] ?? null;
      const verdict = decide(
        {
          accountId,
          chainKey,
          counterpartyAddress: normalizeCounterparty(counterparty),
          counterpartyKey: counterparty === null ? null : (keys.get(counterparty) ?? null),
          description: row.description,
        },
        { ownWallets, rules }
      );
      if (verdict === null) continue;
      const destination = verdict.destinationAccountId;
      const isOutflow = new Decimal(row.quantity).isNegative();
      if (destination !== undefined && isOutflow && (await mayTakeLeg(destination))) {
        const leg = await this.mirror.write(
          {
            userId,
            accountId,
            rowId: row.id,
            externalId: row.externalId,
            inputId,
            tokenId: row.tokenId,
            amount: row.quantity,
            occurredAt: row.occurredAt,
            counterparty: row.counterparty,
          },
          destination,
          tx
        );
        if (leg !== null && 'holdingId' in leg) {
          outcome.mirrorLegs.push({ holdingId: leg.holdingId, at: row.occurredAt });
          continue;
        }
        if (leg !== null) outcome.notices.push(leg.notice);
      }
      if (verdict.ledgerKind !== undefined) {
        await this.ledger.labelByRule(userId, row.id, verdict.ledgerKind, tx);
      }
    }
    return outcome;
  }
}

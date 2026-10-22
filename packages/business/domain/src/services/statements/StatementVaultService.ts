import { type DatabaseTransaction, getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { and, asc, desc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { RecordNotAccessibleError } from '../../lib/record-not-accessible';
import { statementGaps } from '../../lib/statements/coverage';
import { DocumentRetentionService } from '../documents/DocumentRetentionService';
import { STATEMENT_INPUT_SOURCE } from '../foundation/plan-feed-inputs';

export interface AccountStatement {
  windowId: string;
  /** `YYYY-MM-DD`, UTC. */
  from: string;
  to: string;
  readAt: Date;
  /** NULL for a window recorded before SC-1656, or whose file was deleted. */
  document: { id: string; filename: string; downloadable: boolean } | null;
}

export interface AccountStatements {
  statements: AccountStatement[];
  /** `YYYY-MM`, oldest first. */
  gaps: string[];
}

const dayOf = (at: Date): string => at.toISOString().slice(0, 10);

function lastCompleteMonth(now: Date): string {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return dayOf(new Date(start.getTime() - 1)).slice(0, 7);
}

/** An account's bank statements and the months none covers (SC-1656). */
@Service()
export class StatementVaultService {
  private readonly retention = Container.get(DocumentRetentionService);

  async forAccount(
    userId: string,
    accountId: string,
    now: Date,
    tx?: DatabaseTransaction
  ): Promise<AccountStatements> {
    const db = tx ?? getDb();
    const [account] = await db
      .select({ isActive: schema.accounts.isActive })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.userId, userId)));
    if (!account) throw new RecordNotAccessibleError('account', 'Account not found');

    const w = schema.feedInputWindows;
    const rows = await db
      .select({
        windowId: w.id,
        fromAt: w.fromAt,
        toAt: w.toAt,
        readAt: w.fetchedAt,
        documentId: schema.documents.id,
        filename: schema.documents.originalFilename,
        r2Key: schema.documents.r2Key,
      })
      .from(w)
      .innerJoin(schema.feedInputs, eq(schema.feedInputs.id, w.inputId))
      .leftJoin(schema.documents, eq(schema.documents.id, w.documentId))
      .where(
        and(
          eq(schema.feedInputs.accountId, accountId),
          eq(schema.feedInputs.source, STATEMENT_INPUT_SOURCE),
          // A window from before SC-1665 has no shape; on this input it is a statement.
          or(eq(w.shape, 'statement-upload'), isNull(w.shape))
        )
      )
      .orderBy(desc(w.toAt), desc(w.fetchedAt));

    const statements = rows.map((row) => ({
      windowId: row.windowId,
      from: dayOf(row.fromAt ?? row.toAt),
      to: dayOf(row.toAt),
      readAt: row.readAt,
      document:
        row.documentId && row.filename !== null && row.r2Key !== null
          ? {
              id: row.documentId,
              filename: row.filename,
              downloadable: this.retention.isRetained(row.r2Key),
            }
          : null,
    }));
    const latest = statements[0]?.to.slice(0, 7);
    const through = account.isActive || !latest ? lastCompleteMonth(now) : latest;
    return { statements, gaps: statementGaps({ statements, through }) };
  }

  /** The accounts each of the user's documents was read into as a statement. */
  async accountsByDocument(
    userId: string,
    documentIds: readonly string[],
    tx?: DatabaseTransaction
  ): Promise<Map<string, { id: string; name: string }[]>> {
    const named = new Map<string, { id: string; name: string }[]>();
    if (documentIds.length === 0) return named;
    const rows = await (tx ?? getDb())
      .selectDistinct({
        documentId: schema.feedInputWindows.documentId,
        id: schema.accounts.id,
        name: schema.accounts.name,
      })
      .from(schema.feedInputWindows)
      .innerJoin(schema.feedInputs, eq(schema.feedInputs.id, schema.feedInputWindows.inputId))
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.feedInputs.accountId))
      .where(
        and(
          eq(schema.feedInputs.userId, userId),
          isNotNull(schema.feedInputWindows.documentId),
          inArray(schema.feedInputWindows.documentId, [...documentIds])
        )
      )
      .orderBy(asc(schema.accounts.name));
    for (const row of rows) {
      if (!row.documentId) continue;
      named.set(row.documentId, [
        ...(named.get(row.documentId) ?? []),
        { id: row.id, name: row.name },
      ]);
    }
    return named;
  }
}

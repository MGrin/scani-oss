import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { GroupRepository, UserRepository } from '@scani/domain/repositories';
import { RenderPdfInput } from '@scani/shared';
import { desc, eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { toNetWorthHistoryRow, userNetWorthDaily } from '../../lib/net-worth-series';
import { accountLabel } from '../../lib/pdf/layout';
import { renderStatement } from '../../lib/pdf/statement';
import { strictInput } from '../lib/strict-input';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

/**
 * "Export everything" — one query that returns a portable copy of the account.
 *
 * Scani's whole positioning is that the data is the reader's own: open source,
 * self-hostable, no lock-in. An export-everything button is the only thing that
 * makes that claim checkable, and it is what gives a self-hoster a way *off*
 * the hosted version. So this is a product promise with a router behind it, not
 * a convenience.
 *
 * **Why this is server work, when the list exports are not.** A list's rows are
 * already in the client — the page fetched them to draw the table — so building
 * that CSV in the browser is free, instant, and identical by construction to
 * what is on screen. Nothing about "everything" is like that. The ledger has no
 * unbounded client query (`transactions.list` is capped at 500 rows a page, on
 * purpose), the daily rollup is thousands of rows nothing renders, and paging
 * fourteen endpoints from a phone to reassemble them would be slower, more
 * fragile, and a second definition of "everything" that drifts from this one.
 * One pass, one transaction-consistent snapshot, one place to add the next set.
 *
 * **What is deliberately not in it.** `user_integration_credentials` holds
 * AES-256-GCM-encrypted exchange and brokerage keys; sessions and verification
 * tokens are live authentication material. None of the three is *the reader's
 * financial data* — they are the machinery for fetching it — and a file that
 * lands in a Downloads folder, a mail attachment and a backup is the wrong
 * place for any of them. Re-connecting an integration on a new install is a
 * two-minute job; a leaked exchange key is not.
 *
 * Names are joined in beside every foreign key rather than replacing it. The id
 * is what makes the file re-importable; the name is what makes it readable, and
 * a export that offers only one of those is either a spreadsheet nobody can
 * read or a backup nobody can restore.
 */

/** The rollup's own ceiling. Six years of daily rows is ~2,200 records — large
 *  for a payload, small for a database, and the alternative is an export that
 *  quietly begins in the middle of someone's history. */
const HISTORY_DAYS = 365 * 6;
const DAY_MS = 24 * 60 * 60 * 1000;

export const exportsRouter = router({
  /**
   * Render a document the client has already assembled (SC-94).
   *
   * A **renderer**, deliberately: it is handed the same `ExportSheet` that
   * becomes the CSV and it decides only how that looks. It does not read the
   * user's holdings, and it must not — a server that re-derived what a holdings
   * list contains would be a second definition of twelve surfaces' columns, and
   * the PDF would drift from the CSV beside it. That is the exact class of bug
   * SC-89 built one shared export path to avoid.
   *
   * It follows that this procedure reads no user data of its own — the payload
   * is the caller's own screen, sent back for typesetting — with **one
   * exception**: the account the statement names. That comes from the session
   * and never from the input. A document sent to a bank or an accountant says
   * whose it is, and a name the caller supplied would be a claim the server
   * merely relayed. Authentication still matters for the rest of it too:
   * rendering is CPU work and this is the one endpoint that will happily burn
   * it, which is what `PDF_MAX_ROWS` bounds.
   *
   * Base64 rather than a binary response: tRPC's transformer is JSON, and a
   * statement is tens of kilobytes, so the 33% overhead costs less than a
   * second transport with its own auth path would.
   */
  renderPdf: protectedProcedure
    .input(strictInput(RenderPdfInput))
    .mutation(async ({ ctx, input }) => {
      const { dbUser } = await requireAuth(ctx);
      const pdf = await renderStatement({
        ...input,
        account: accountLabel(dbUser.name, dbUser.email),
      });
      await Container.get(UserRepository).markFirstExport(dbUser.id);
      return { base64: pdf.toString('base64') };
    }),

  everything: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    const userId = dbUser.id;

    const [accounts, holdings, vendors, payments, groups, vaults, documents] = await Promise.all([
      db
        .select({
          id: schema.accounts.id,
          name: schema.accounts.name,
          institutionId: schema.accounts.institutionId,
          institutionName: schema.institutions.name,
          type: schema.accountTypes.name,
          description: schema.accounts.description,
          isHidden: schema.accounts.isHidden,
          isActive: schema.accounts.isActive,
          createdAt: schema.accounts.createdAt,
        })
        .from(schema.accounts)
        .innerJoin(schema.institutions, eq(schema.institutions.id, schema.accounts.institutionId))
        .innerJoin(schema.accountTypes, eq(schema.accountTypes.id, schema.accounts.typeId))
        .where(eq(schema.accounts.userId, userId)),

      db
        .select({
          id: schema.holdings.id,
          accountId: schema.holdings.accountId,
          accountName: schema.accounts.name,
          institutionName: schema.institutions.name,
          tokenId: schema.holdings.tokenId,
          symbol: schema.tokens.symbol,
          tokenName: schema.tokens.name,
          balance: schema.holdings.balance,
          source: schema.holdings.source,
          isHidden: schema.holdings.isHidden,
          isActive: schema.holdings.isActive,
          lastUpdated: schema.holdings.lastUpdated,
          createdAt: schema.holdings.createdAt,
        })
        .from(schema.holdings)
        .innerJoin(schema.accounts, eq(schema.accounts.id, schema.holdings.accountId))
        .innerJoin(schema.institutions, eq(schema.institutions.id, schema.accounts.institutionId))
        .innerJoin(schema.tokens, eq(schema.tokens.id, schema.holdings.tokenId))
        .where(eq(schema.holdings.userId, userId)),

      db
        .select({
          id: schema.vendors.id,
          displayName: schema.vendors.displayName,
          category: schema.vendors.category,
          website: schema.vendors.website,
          createdAt: schema.vendors.createdAt,
        })
        .from(schema.vendors)
        .where(eq(schema.vendors.userId, userId)),

      db
        .select({
          id: schema.payments.id,
          vendorId: schema.payments.vendorId,
          vendorName: schema.vendors.displayName,
          direction: schema.payments.direction,
          kind: schema.payments.kind,
          expectedAmount: schema.payments.expectedAmount,
          currency: schema.tokens.symbol,
          intervalUnit: schema.payments.intervalUnit,
          intervalCount: schema.payments.intervalCount,
          anchorDate: schema.payments.anchorDate,
          endDate: schema.payments.endDate,
          status: schema.payments.status,
          origin: schema.payments.origin,
          notes: schema.payments.notes,
          createdAt: schema.payments.createdAt,
        })
        .from(schema.payments)
        .innerJoin(schema.vendors, eq(schema.vendors.id, schema.payments.vendorId))
        .innerJoin(schema.tokens, eq(schema.tokens.id, schema.payments.currencyTokenId))
        .where(eq(schema.payments.userId, userId)),

      db
        .select({
          id: schema.groups.id,
          name: schema.groups.name,
          description: schema.groups.description,
          color: schema.groups.color,
          isActive: schema.groups.isActive,
          createdAt: schema.groups.createdAt,
        })
        .from(schema.groups)
        .where(eq(schema.groups.userId, userId)),

      db
        .select({
          id: schema.vaults.id,
          name: schema.vaults.name,
          description: schema.vaults.description,
          targetAmount: schema.vaults.targetAmount,
          currentAmount: schema.vaults.currentAmount,
          currency: schema.tokens.symbol,
          isActive: schema.vaults.isActive,
          createdAt: schema.vaults.createdAt,
        })
        .from(schema.vaults)
        .innerJoin(schema.tokens, eq(schema.tokens.id, schema.vaults.currencyId))
        .where(eq(schema.vaults.userId, userId)),

      db
        .select({
          id: schema.documents.id,
          filename: schema.documents.originalFilename,
          purpose: schema.documents.purpose,
          mimeType: schema.documents.mimeType,
          byteSize: schema.documents.byteSize,
          sourceKind: schema.documents.sourceKind,
          classification: schema.documents.classification,
          createdAt: schema.documents.createdAt,
        })
        .from(schema.documents)
        .where(eq(schema.documents.userId, userId)),
    ]);

    const paymentIds = payments.map((payment) => payment.id);
    const groupIds = groups.map((group) => group.id);
    const vaultIds = vaults.map((vault) => vault.id);

    const [transactions, occurrences, holdingMembers, accountMembers, vaultMembers, history] =
      await Promise.all([
        db
          .select({
            id: schema.holdingTransactions.id,
            occurredAt: schema.holdingTransactions.occurredAt,
            holdingId: schema.holdingTransactions.holdingId,
            accountName: schema.accounts.name,
            symbol: schema.tokens.symbol,
            kind: schema.holdingTransactions.kind,
            quantity: schema.holdingTransactions.quantity,
            priceNative: schema.holdingTransactions.priceNative,
            counterQuantity: schema.holdingTransactions.counterQuantity,
            feeQuantity: schema.holdingTransactions.feeQuantity,
            source: schema.holdingTransactions.source,
            externalId: schema.holdingTransactions.externalId,
            counterparty: schema.holdingTransactions.counterparty,
            description: schema.holdingTransactions.description,
          })
          .from(schema.holdingTransactions)
          .innerJoin(schema.holdings, eq(schema.holdings.id, schema.holdingTransactions.holdingId))
          .innerJoin(schema.accounts, eq(schema.accounts.id, schema.holdings.accountId))
          .innerJoin(schema.tokens, eq(schema.tokens.id, schema.holdingTransactions.tokenId))
          .where(eq(schema.holdingTransactions.userId, userId))
          .orderBy(desc(schema.holdingTransactions.occurredAt)),

        paymentIds.length === 0
          ? []
          : db
              .select({
                paymentId: schema.paymentOccurrences.paymentId,
                dueDate: schema.paymentOccurrences.dueDate,
                status: schema.paymentOccurrences.status,
                expectedAmount: schema.paymentOccurrences.expectedAmount,
                actualAmount: schema.paymentOccurrences.actualAmount,
              })
              .from(schema.paymentOccurrences)
              .where(inArray(schema.paymentOccurrences.paymentId, paymentIds)),

        // EFFECTIVE membership, not the `holding_groups` rows: an account in a
        // group carries everything in it (SC-386), and a vetoed holding is out
        // of it despite having a row. Reading the table raw would export a
        // group that omits what its own page lists and lists what its own page
        // omits.
        Container.get(GroupRepository).findHoldingIdsByGroupIds(userId, groupIds),

        groupIds.length === 0
          ? []
          : db
              .select({
                groupId: schema.accountGroups.groupId,
                accountId: schema.accountGroups.accountId,
              })
              .from(schema.accountGroups)
              .where(inArray(schema.accountGroups.groupId, groupIds)),

        vaultIds.length === 0
          ? []
          : db
              .select({
                vaultId: schema.vaultHoldings.vaultId,
                holdingId: schema.vaultHoldings.holdingId,
                percentage: schema.vaultHoldings.percentage,
              })
              .from(schema.vaultHoldings)
              .where(inArray(schema.vaultHoldings.vaultId, vaultIds)),

        // The SAME function the home chart's export reads (SC-98). This used to
        // select `scope_kind = 'user'` straight out of `portfolio_value_daily`
        // — a second, independent measurement — so the workbook and the CSV
        // stated different net worths for the same date whenever the rollup was
        // mid-run. Two of our own files disagreeing is worse than either being
        // wrong on its own.
        dbUser.baseCurrencyId
          ? userNetWorthDaily(
              userId,
              dbUser.baseCurrencyId,
              new Date(Date.now() - HISTORY_DAYS * DAY_MS),
              new Date()
            ).then((rows) => rows.map(toNetWorthHistoryRow))
          : [],
      ]);

    const accountName = new Map(accounts.map((account) => [account.id, account.name]));
    const holdingName = new Map(
      holdings.map((holding) => [holding.id, `${holding.symbol} · ${holding.accountName}`])
    );
    const groupName = new Map(groups.map((group) => [group.id, group.name]));
    const vaultName = new Map(vaults.map((vault) => [vault.id, vault.name]));
    const paymentVendor = new Map(payments.map((payment) => [payment.id, payment.vendorName]));

    // Funnel step 6 (SC-450). After the payload is assembled, so a query that
    // threw halfway is not recorded as a file someone received. It is a query
    // rather than a mutation for cacheability, but nothing mounts it — both
    // call sites are an imperative `.query()` behind a button — so this fires
    // once per real export, not once per page view.
    await Container.get(UserRepository).markFirstExport(userId);

    return {
      profile: {
        email: dbUser.email,
        name: dbUser.name,
        baseCurrency: dbUser.baseCurrencyId,
        createdAt: dbUser.createdAt,
      },
      // One flat membership set rather than two: a reader asking "what is in
      // this group" does not care that a holding and an account reach it by
      // different tables, and two near-identical sheets is two sheets to join.
      groupMembers: [
        ...holdingMembers.map((row) => ({
          group: groupName.get(row.groupId) ?? row.groupId,
          memberKind: 'holding' as const,
          member: holdingName.get(row.holdingId) ?? row.holdingId,
        })),
        ...accountMembers.map((row) => ({
          group: groupName.get(row.groupId) ?? row.groupId,
          memberKind: 'account' as const,
          member: accountName.get(row.accountId) ?? row.accountId,
        })),
      ],
      vaultHoldings: vaultMembers.map((row) => ({
        vault: vaultName.get(row.vaultId) ?? row.vaultId,
        holding: holdingName.get(row.holdingId) ?? row.holdingId,
        percentage: row.percentage,
      })),
      paymentOccurrences: occurrences.map((row) => ({
        vendor: paymentVendor.get(row.paymentId) ?? row.paymentId,
        dueDate: row.dueDate,
        status: row.status,
        expectedAmount: row.expectedAmount,
        actualAmount: row.actualAmount,
      })),
      accounts,
      holdings,
      transactions,
      vendors,
      payments,
      groups,
      vaults,
      documents,
      netWorthDaily: history,
    };
  }),
});

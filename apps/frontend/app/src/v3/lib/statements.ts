import { formatDateRange, formatMonthYear } from '@scani/shared';

/** `accounts.listStatements`, as the wire carries it (SC-1656). */
export interface AccountStatementsSummary {
  statements: {
    windowId: string;
    from: string;
    to: string;
    readAt: string;
    document: { id: string; filename: string; downloadable: boolean } | null;
  }[];
  gaps: string[];
}

export interface StatementsView {
  rows: { key: string; period: string; filename: string | null; documentId: string | null }[];
  gaps: string[];
}

/** Null for an account with no statements: the section is not shown. */
export function toStatementsView(
  summary: AccountStatementsSummary | null | undefined
): StatementsView | null {
  if (!summary || summary.statements.length === 0) return null;
  return {
    rows: summary.statements.map((s) => ({
      key: s.windowId,
      period: formatDateRange(s.from, s.to),
      filename: s.document?.filename ?? null,
      documentId: s.document?.id ?? null,
    })),
    gaps: summary.gaps.map((gap) => formatMonthYear(gap)),
  };
}

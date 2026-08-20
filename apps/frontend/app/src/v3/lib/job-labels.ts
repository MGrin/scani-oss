/**
 * Human labels + icons for each user-initiated job name, in v3's language.
 *
 * v2's copy of this module stays where it is and dies with that tree (SC-320).
 * The two cannot be one file: `v3.*` keys are registered by `src/v3/i18n`,
 * which only the v3 chunk imports, so a shared module calling `t('v3.…')` and
 * rendered under `/v2` would put the raw key on the screen. That is the same
 * constraint `tests/lib/i18n-locales.test.ts` enforces from the other side —
 * the eager bundle may not carry v3's strings.
 *
 * Keep in sync with `JOB_NAMES` in `packages/infra/queue/src/queue-names.ts`.
 */

import type { TFunction } from 'i18next';
import type { LucideIcon } from 'lucide-react';
import {
  Coins,
  DollarSign,
  FileSpreadsheet,
  FileText,
  History,
  Image as ImageIcon,
  Keyboard,
  Link2,
  Trash2,
} from 'lucide-react';

export interface JobLabel {
  label: string;
  icon: LucideIcon;
}

/**
 * Whole keys rather than a suffix interpolated into `t()`: the `…Key:`
 * convention is what `tests/lib/i18n-keys.test.ts` scans for, and a key
 * assembled at the call site is one no guard can see resolve.
 */
const BY_NAME: Record<string, { labelKey: string; icon: LucideIcon }> = {
  'wallet-import': { labelKey: 'v3.jobs.label.walletImport', icon: Coins },
  'exchange-import': { labelKey: 'v3.jobs.label.exchangeImport', icon: Link2 },
  // Covers both images and PDFs — the label in the result body
  // differentiates further based on the file extension.
  'screenshot-parse': { labelKey: 'v3.jobs.label.documentParse', icon: ImageIcon },
  'document-parse': { labelKey: 'v3.jobs.label.invoiceParse', icon: FileText },
  'file-import': { labelKey: 'v3.jobs.label.fileImport', icon: FileSpreadsheet },
  'manual-holdings-create': { labelKey: 'v3.jobs.label.manualHoldings', icon: Keyboard },
  'portfolio-history-backfill': { labelKey: 'v3.jobs.label.historyBackfill', icon: History },
  'holding-price-update': { labelKey: 'v3.jobs.label.priceRefresh', icon: DollarSign },
  'user-data-delete': { labelKey: 'v3.jobs.label.accountDeletion', icon: Trash2 },
  'transaction-import': { labelKey: 'v3.jobs.label.transactionImport', icon: History },
};

/**
 * An unrecognised job name renders as itself, which is what v2 does and the
 * only thing left to say: a queue that has grown a name this table has not is
 * better read as `refund-reconcile` than under a label shared with every other
 * unknown. v2 carried a `'Background task'` constant for this branch and then
 * overwrote it with the name on the same line, so it never reached a screen —
 * it is not carried over rather than translated into a string nothing renders.
 */
export function jobLabelFor(t: TFunction, jobName: string): JobLabel {
  const known = BY_NAME[jobName];
  if (!known) return { label: jobName, icon: Coins };
  return { label: t(known.labelKey), icon: known.icon };
}

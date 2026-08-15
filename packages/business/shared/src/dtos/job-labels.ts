/**
 * What each user-initiated job is called, in the user's words.
 *
 * One map, because there were two: the frontend's `jobLabels.ts` (list rows,
 * detail header, badge tooltip) and a three-entry copy inside
 * `ReviewFeedService` carrying a comment asking whoever edited it to keep the
 * two in step by hand. The same job reading "Screenshot import" on /review and
 * "Document parse" on /jobs is two different things to the person looking at
 * it, and a hand-kept copy of a map is a drift that eventually ships.
 *
 * Icons stay in the frontend — they are presentation, and the server has no
 * use for a Lucide component.
 */
const USER_JOB_TITLES: Record<string, string> = {
  'wallet-import': 'Wallet import',
  'exchange-import': 'Exchange import',
  // Covers both images and PDFs — the result body differentiates further
  // based on the file extension.
  'screenshot-parse': 'Document parse',
  'document-parse': 'Invoice parse',
  'file-import': 'File import',
  'manual-holdings-create': 'Manual holdings',
  'portfolio-history-backfill': 'History backfill',
  'holding-price-update': 'Price refresh',
  'user-data-delete': 'Account deletion',
  'transaction-import': 'Transaction history import',
};

/**
 * Falls back to the raw job name rather than to a generic "Background task":
 * an unlabelled name is at least searchable and greppable, and it makes the
 * missing entry obvious the first time someone sees one.
 */
export function userJobTitle(jobName: string): string {
  return USER_JOB_TITLES[jobName] ?? jobName;
}

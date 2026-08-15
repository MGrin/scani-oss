import { V3_ROUTES } from './routes';

/**
 * Tokens — two lists of the same kind of exception, behind a segmented control.
 *
 * v2 stacks them as two sections of one scrolling page: manually-priced custom
 * tokens, then holdings hidden from the dashboard. They belong together (both
 * are "assets the automatic pipeline does not handle for you") and neither is
 * long enough to earn a destination, but stacked they cost two search boxes and
 * two empty states on one screen. Segments give each its own list, its own
 * peek and its own URL, at the price of one control.
 *
 * The segment is a route for the same reason Money's is: `hidden` is claimed
 * before the peek's id space, so `/v3/tokens/hidden` is the hidden list and
 * `/v3/tokens/<uuid>` is a custom token's sheet. Token ids are uuids, so
 * nothing can collide with the reserved word.
 */

export type TokenSegment = 'custom' | 'hidden';

export interface TokenSegmentDef {
  key: TokenSegment;
  label: string;
  path: string;
}

export const TOKENS_HIDDEN_PATH = `${V3_ROUTES.tokens}/hidden`;

export const TOKEN_SEGMENTS: readonly TokenSegmentDef[] = [
  { key: 'custom', label: 'Custom', path: V3_ROUTES.tokens },
  { key: 'hidden', label: 'Hidden', path: TOKENS_HIDDEN_PATH },
];

export const DEFAULT_TOKEN_SEGMENT: TokenSegment = 'custom';

function stripTrailingSlash(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

export function resolveTokenSegment(pathname: string): TokenSegment {
  const path = stripTrailingSlash(pathname);
  if (path === TOKENS_HIDDEN_PATH || path.startsWith(`${TOKENS_HIDDEN_PATH}/`)) return 'hidden';
  return DEFAULT_TOKEN_SEGMENT;
}

export function tokenSegmentPath(segment: TokenSegment): string {
  return TOKEN_SEGMENTS.find((entry) => entry.key === segment)?.path ?? V3_ROUTES.tokens;
}

/** The fields the hidden list reads off a `holdings.getHidden` row. */
export interface HiddenHoldingRow {
  id: string;
  balance: string;
  hiddenReason: 'user_hidden' | 'scam' | 'both';
  token: { id: string; symbol: string; name: string; isScamProbability: number };
  account: { id: string; name: string };
  institution: { id: string; name: string };
}

const HIDDEN_REASONS: Record<HiddenHoldingRow['hiddenReason'], string> = {
  user_hidden: 'Hidden by you',
  scam: 'Flagged as a likely scam',
  both: 'Flagged as a likely scam, and hidden by you',
};

export function hiddenReasonLabel(reason: HiddenHoldingRow['hiddenReason']): string {
  return HIDDEN_REASONS[reason] ?? reason;
}

export function isScamFlagged(holding: Pick<HiddenHoldingRow, 'hiddenReason'>): boolean {
  return holding.hiddenReason === 'scam' || holding.hiddenReason === 'both';
}

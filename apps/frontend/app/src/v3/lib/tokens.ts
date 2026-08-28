import { stripTrailingSlash } from '@scani/ui/v3/lib/path';
import type { TFunction } from 'i18next';
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
  labelKey: string;
  path: string;
}

export const TOKENS_HIDDEN_PATH = `${V3_ROUTES.tokens}/hidden`;

export const TOKEN_SEGMENTS: readonly TokenSegmentDef[] = [
  { key: 'custom', labelKey: 'v3.tokens.segment.custom', path: V3_ROUTES.tokens },
  { key: 'hidden', labelKey: 'v3.tokens.segment.hidden', path: TOKENS_HIDDEN_PATH },
];

export const DEFAULT_TOKEN_SEGMENT: TokenSegment = 'custom';

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

const HIDDEN_REASON_KEYS: Record<HiddenHoldingRow['hiddenReason'], string> = {
  user_hidden: 'v3.tokens.hiddenReason.user',
  scam: 'v3.tokens.hiddenReason.scam',
  both: 'v3.tokens.hiddenReason.both',
};

export function hiddenReasonLabel(t: TFunction, reason: HiddenHoldingRow['hiddenReason']): string {
  return t(HIDDEN_REASON_KEYS[reason]) ?? reason;
}

/**
 * `token_types.code` -> the key its name renders under.
 *
 * `token_types.name` is English prose in Postgres — "Fiat Currency",
 * "Cryptocurrency" — seeded once at `0000_clean_start.sql:649` and reachable by
 * no locale file, so six shipped languages render it in English. The code beside
 * it is `notNull().unique()` and already on every DTO that carries the name, so
 * a map on the code translates all six render sites with no migration, no wire
 * change and nothing new to write.
 *
 * `{ code, labelKey }` rather than a `Record` keyed by code, which is the shape
 * `HIDDEN_REASON_KEYS` above uses: `tests/lib/i18n-keys.test.ts` finds an
 * indirect key by the `...Key:` property name, so a `Record` is invisible to the
 * one gate that catches a typo — and i18next renders a key it cannot resolve as
 * the key itself, in the chart legend on the home screen.
 */
export const TOKEN_TYPE_LABELS: readonly { code: string; labelKey: string }[] = [
  { code: 'fiat', labelKey: 'v3.tokens.type.fiat' },
  { code: 'crypto', labelKey: 'v3.tokens.type.crypto' },
  { code: 'stock', labelKey: 'v3.tokens.type.stock' },
  { code: 'private-company', labelKey: 'v3.tokens.type.privateCompany' },
  { code: 'other', labelKey: 'v3.tokens.type.other' },
];

/**
 * A token type's name, translated where the code is one we seeded.
 *
 * The stored-name fallback is load-bearing rather than defensive. `token_types`
 * is a dynamic enum — rows, not a SQL enum — and the schema says so
 * (`schema/tokens.ts:109`, "Admin-extensible without a migration"); nothing in
 * the api, the worker or either frontend inserts one today, but the shape is
 * built to allow it. A sixth type therefore renders exactly what it renders
 * now, its stored English name, instead of degrading. Falling through to the
 * code would put `private-company` on the screen, and returning nothing would
 * put an unpickable blank row in the holdings filter — a new type would arrive
 * as a defect in a surface nobody changed.
 */
export function tokenTypeLabel(
  t: TFunction,
  code: string | null | undefined,
  storedName?: string | null
): string {
  const entry = TOKEN_TYPE_LABELS.find((candidate) => candidate.code === code);
  if (entry) return t(entry.labelKey);
  return storedName?.trim() || code?.trim() || '';
}

export function isScamFlagged(holding: Pick<HiddenHoldingRow, 'hiddenReason'>): boolean {
  return holding.hiddenReason === 'scam' || holding.hiddenReason === 'both';
}

/** Kept aligned with `packages/core/src/config/tokens.ts`. */
const SCAM_PROBABILITY_THRESHOLD = 0.35;

/**
 * Does this token's `isScamProbability` count as scam?
 *
 * NOT `isScamFlagged`, which asks a different question of a different row.
 * That one reads `hiddenReason` off `holdings.getHidden` — the server's record
 * that *this holding* was hidden for being a scam. This one is the score, and
 * it is what a surface holding a plain token uses to decide whether the row is
 * badged or subtracted from a total.
 */
export function isScamToken(probability: number | null | undefined): boolean {
  return typeof probability === 'number' && probability >= SCAM_PROBABILITY_THRESHOLD;
}

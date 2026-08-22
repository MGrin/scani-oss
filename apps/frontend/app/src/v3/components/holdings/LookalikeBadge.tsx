import { Badge } from '@scani/ui/ui/badge';
import type { TFunction } from 'i18next';

/**
 * The symbol a row DRAWS, next to the symbol it is.
 *
 * `UЅDС` (Cyrillic Ѕ and С) and `USDC` are the same picture. Nine rows in
 * production are built that way, and until this badge existed the mark sat
 * in `tokens.lookalike_of` where nothing read it — the database knew and
 * the user could not (SC-219).
 *
 * The badge says what it imitates rather than warning, because a warning
 * does not survive the comparison the reader is actually making. "Suspicious"
 * on a row captioned `UЅDС`, beside a row captioned `USDC`, leaves them still
 * looking alike; "Displays as USDC" is the only form that makes the two rows
 * different to look at, which is the whole job.
 *
 * Deliberately NOT the scam style, and deliberately distinct from `No price`.
 * They are three different facts and they co-occur constantly — a lookalike is
 * usually also unpriced. A reader who learns to read them as one thing learns
 * the wrong lesson, and the one that means "these characters are not what they
 * look like" is the one that never changes (SC-207, SC-218).
 *
 * It lives in its own module rather than in `holdingsConfig` because the peek
 * sheet prints the symbol too, as the unit on the amount (SC-559), and
 * `holdingsConfig` imports `holdingPeek` — so the badge cannot travel in the
 * direction the second caller needs.
 */
export function LookalikeBadge({
  symbol,
  impersonates,
  t,
}: {
  symbol: string;
  impersonates: string;
  t: TFunction;
}) {
  return (
    <Badge
      variant="secondary"
      className="shrink-0"
      title={t('v3.holdings.badge.lookalikeTitle', { impersonates })}
    >
      {/* `symbol` is offered and English does not spend the badge width on it
          (SC-235). "Displays as USDC" is a clause with no subject: the ROW is
          the subject, supplied by the badge sitting beside the symbol, and a
          translator reading `en.json` cannot see that a subject exists — let
          alone whether their language may leave it out. Passing it makes the
          subject available to whoever needs to state it, without English
          paying for a word it does not need at 390px, where this badge already
          competes with two others for the row. */}
      {t('v3.holdings.badge.lookalike', { symbol, impersonates })}
    </Badge>
  );
}

import { normalizeVendorName } from './normalize-vendor-name';

/**
 * Legal-form tokens, stripped only from the END of an already-normalised
 * name. "Hetzner Online GmbH" and "Hetzner Online" are one company; "Fly.io"
 * and "Fly.io, Inc." are one company. Requiring a preceding space means a
 * vendor genuinely called "Ltd" or "Co" survives intact, and a name ending in
 * "…taco" is never mistaken for a trailing "co".
 *
 * Multi-word forms come first only for readability — the pattern is anchored
 * at `$`, so the engine backtracks to whichever alternative reaches the end.
 * "S.à r.l." arrives here as "s r l" because `normalizeVendorName` drops the
 * non-ASCII "à" along with the punctuation, hence both spellings are listed.
 */
const LEGAL_FORM_SUFFIX =
  /\s(?:s a r l|s r l|s a s|s p a|sp z o o|z o o|d o o|incorporated|corporation|company|limited|gmbh|mbh|kgaa|nyrt|sarl|ltda|slu|sdn|bhd|kft|zrt|sro|doo|oyj|aps|pty|pte|plc|llc|llp|inc|corp|ltd|spa|sas|srl|nv|bv|ab|oy|ag|ug|kg|eg|ev|sa|sl|co|as)$/;

// "Muster GmbH & Co. KG" needs three passes; the cap exists so the TypeScript
// loop and the one-shot SQL backfill in migration 0027 (four nested
// `regexp_replace` calls) can never disagree on a pathological name.
const MAX_SUFFIX_STRIPS = 4;

/**
 * The key two vendor names are compared on. `normalizeVendorName` collapses
 * case, punctuation and processor prefixes for the SAME string; this goes one
 * step further and drops the legal form, which is the noise that actually
 * causes duplicates — every extractor phrases it differently.
 *
 * Stored on `vendors.match_key` (written by this function on every insert, and
 * backfilled once by migration 0027) so Postgres can both equality-match it and
 * run `similarity()` against it through the GIN trigram index.
 */
export function vendorMatchKey(raw: string): string {
  let key = normalizeVendorName(raw);
  for (let pass = 0; pass < MAX_SUFFIX_STRIPS; pass += 1) {
    const stripped = key.replace(LEGAL_FORM_SUFFIX, '');
    if (stripped === key) break;
    key = stripped;
  }
  return key;
}

/**
 * Above this trigram similarity a vendor is reused SILENTLY, with no one
 * asked. Deliberately far above the noise floor, because attaching a bill to
 * the wrong company is worse than creating a duplicate.
 *
 * Measured on real pairs with pg_trgm 1.6 (match keys, so the legal form is
 * already gone). The worst FALSE positive is `apple` vs `apple bank` at 0.545
 * — two different companies sharing a first word. Genuine typos and
 * truncations sit at 0.583 ("anthropic"/"anthropc"), 0.615 ("cloudflare"/
 * "cloudfare"), 0.688 ("digitalocean"/"digital ocean"), 0.714 ("amazon web
 * services"/"amazon web serv"), 0.813 ("hetzner online"/"hetzner onlin").
 *
 * Those bands OVERLAP, so no trigram threshold separates them: 0.85 buys a
 * 0.30 margin over the worst false positive and only fires on strings that are
 * near-identical already. Everything between the two thresholds is surfaced,
 * never applied. The pairs this ticket was actually filed about — "Hetzner
 * Online GmbH"/"Hetzner Online", "Fly.io"/"Fly.io, Inc." — are handled by
 * match-key EQUALITY (similarity 1.0) rather than by this threshold at all.
 */
export const VENDOR_MATCH_AUTO_THRESHOLD = 0.85;

/**
 * Below this a candidate isn't shown at all. 0.45 keeps "apple"/"apple bank"
 * (0.545) and "shell"/"shell energy" (0.462) visible as questions the user can
 * answer, while dropping "deutsche bank"/"deutsche telekom" (0.409),
 * "total"/"total energies" (0.400) and "bp"/"bp fuel" (0.375), which share a
 * first word and nothing else.
 */
export const VENDOR_MATCH_SUGGEST_THRESHOLD = 0.45;

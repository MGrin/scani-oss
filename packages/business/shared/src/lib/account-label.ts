/**
 * Naming an account without saying its institution twice (SC-850).
 *
 * Production's transfer picker read `Airwallex · Airwallex` and `Bitcoin
 * Network · Bitcoin Network - bc1q5n…`, because the two fields were
 * concatenated whatever they held. They are not independent: an account named
 * by an importer usually opens with the institution that named it, and a
 * person naming one by hand does the same. So the join has to notice.
 *
 * Here rather than in the picker because two consumers need it and they need
 * different halves — the control renders the institution as its own dim cell,
 * the confirmation sentences need one string. A second implementation of "is
 * this a repeat" would drift, and the drift would be one surface calling an
 * account something the other does not.
 */

/** ` - `, ` · `, `: `, `/` — whatever a writer used to join the two. */
const LEADING_SEPARATORS = /^[\s\-–—·:|/]+/;

/**
 * The same characters at the tail, but WITHOUT plain whitespace, and the
 * asymmetry is the whole point.
 *
 * A LEADING repeat is unambiguous: the name opens with exactly the institution,
 * so `Wise EUR` at Wise is a compound somebody built and `EUR` is the half that
 * identifies it. A TRAILING match is not — `Bitcoin Cash` at an institution
 * called `Cash` ends with it and means nothing of the sort. Requiring real
 * punctuation on this side is what tells `Ledger — Ethereum` (two parts joined)
 * from an ordinary phrase whose last word happens to collide.
 */
const TRAILING_SEPARATORS = /[\s]*[-–—·:|/][\s]*$/;

export interface AccountLabelParts {
  /** Null when there is no institution, or when the name already says it. */
  institution: string | null;
  /** Never empty: an account called nothing but its institution keeps that. */
  name: string;
}

/**
 * The two cells a row renders — the institution, and what is left of the name
 * once a repeat of it has been taken off either end.
 *
 * An account genuinely called nothing but its institution ("Airwallex" at
 * Airwallex) collapses to the one word rather than to an empty leading cell,
 * which reads as a rendering failure rather than as a fact.
 *
 * **Both ends, because the demo seed is three-for-three on the trailing one.**
 * The first version handled leading repeats only, on the reasoning that
 * `Airwallex · Airwallex` and `Bitcoin Network · Bitcoin Network - bc1q5n…` are
 * both leading — which they are, and which made the rule look complete. Then
 * `Ledger — Ethereum` at Ethereum, `Ledger — Bitcoin` at Bitcoin and
 * `Phantom — Solana` at Solana rendered `Ethereum · Ledger — Ethereum`: the
 * same defect, from the same two fields, arriving from the other side. Naming a
 * wallet `<device> — <chain>` is the ordinary convention, so this is the common
 * shape rather than the edge one.
 */
export function accountLabelParts(
  name: string,
  institution: string | null | undefined
): AccountLabelParts {
  const trimmedName = name.trim();
  const trimmedInstitution = institution?.trim() ?? '';
  if (!trimmedInstitution) return { institution: null, name: trimmedName };
  const lowerName = trimmedName.toLowerCase();
  const lowerInstitution = trimmedInstitution.toLowerCase();

  if (lowerName.startsWith(lowerInstitution)) {
    const rest = trimmedName
      .slice(trimmedInstitution.length)
      .replace(LEADING_SEPARATORS, '')
      .trim();
    return rest
      ? { institution: trimmedInstitution, name: rest }
      : { institution: null, name: trimmedName };
  }

  if (lowerName.endsWith(lowerInstitution)) {
    const head = trimmedName.slice(0, trimmedName.length - trimmedInstitution.length);
    // Only when a separator actually joined them — see `TRAILING_SEPARATORS`.
    const rest = TRAILING_SEPARATORS.test(head) ? head.replace(TRAILING_SEPARATORS, '').trim() : '';
    if (rest) return { institution: trimmedInstitution, name: rest };
  }

  return { institution: trimmedInstitution, name: trimmedName };
}

/** The account, named in one string, for a sentence rather than a row. */
export function accountLabel(name: string, institution: string | null | undefined): string {
  const parts = accountLabelParts(name, institution);
  return parts.institution ? `${parts.institution} · ${parts.name}` : parts.name;
}

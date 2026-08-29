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

export interface AccountLabelParts {
  /** Null when there is no institution, or when the name already says it. */
  institution: string | null;
  /** Never empty: an account called nothing but its institution keeps that. */
  name: string;
}

/**
 * The two cells a row renders — the institution, and what is left of the name
 * once a leading repeat of it has been taken off.
 *
 * An account genuinely called nothing but its institution ("Airwallex" at
 * Airwallex) collapses to the one word rather than to an empty leading cell,
 * which reads as a rendering failure rather than as a fact.
 */
export function accountLabelParts(
  name: string,
  institution: string | null | undefined
): AccountLabelParts {
  const trimmedName = name.trim();
  const trimmedInstitution = institution?.trim() ?? '';
  if (!trimmedInstitution) return { institution: null, name: trimmedName };
  if (!trimmedName.toLowerCase().startsWith(trimmedInstitution.toLowerCase())) {
    return { institution: trimmedInstitution, name: trimmedName };
  }
  const rest = trimmedName.slice(trimmedInstitution.length).replace(LEADING_SEPARATORS, '').trim();
  return rest
    ? { institution: trimmedInstitution, name: rest }
    : { institution: null, name: trimmedName };
}

/** The account, named in one string, for a sentence rather than a row. */
export function accountLabel(name: string, institution: string | null | undefined): string {
  const parts = accountLabelParts(name, institution);
  return parts.institution ? `${parts.institution} · ${parts.name}` : parts.name;
}

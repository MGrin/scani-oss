/**
 * Naming an account without saying its institution twice (SC-850).
 *
 * Production's transfer picker read `Airwallex · Airwallex` and `Bitcoin
 * Network · Bitcoin Network - bc1q5n…`, because the two fields were
 * concatenated whatever they held. They are not independent: an account named
 * by an importer usually repeats the institution that named it, and a person
 * naming one by hand does the same. So the join has to notice.
 *
 * Here rather than in the picker because two consumers need it and they need
 * different halves — the control renders the institution as its own dim cell,
 * the confirmation sentences need one string. A second implementation of "is
 * this a repeat" would drift, and the drift would be one surface calling an
 * account something the other does not.
 *
 * ## THE ONE RULE TO READ BEFORE CHANGING ANY OF THIS
 *
 * **The two errors here do not cost the same, so the rule is not balanced and
 * must not be made so.**
 *
 *     a MISS      leaves a label looking silly — `Wise · Wise EUR`
 *     a FALSE HIT renames a user's account in the picker they move money with
 *
 * Every judgement below leans toward the miss. If you are widening this to
 * catch a case it currently keeps, the question is not "is this a repeat?" —
 * it is "could this string be an account name somebody chose?", and while the
 * answer is *maybe*, keeping it is the correct behaviour.
 */

/**
 * A repeat is only taken off when real PUNCTUATION joined the two parts, at
 * whichever end it sits.
 *
 * Whitespace alone is not enough and that is the whole safety property.
 *
 * **`Wise EUR` and `Wise Guys` are structurally identical, so no rule separates
 * them without semantics.** Both are the institution, a space, and a word. That
 * is not a case this function has failed to handle — it is a case that is not
 * decidable here, and the distinction matters to whoever reads this next: there
 * is no cleverer predicate to find, so both are kept. The first reads a little
 * redundantly; the second is not silently renamed to `Guys`. Same at the tail,
 * where `Cash App Savings` at an institution called `Cash` would otherwise
 * become `App Savings`.
 *
 * This costs two of the demo seed's accounts (`Wise EUR`, `Kraken Spot`),
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 */
const JOINED_AT_HEAD = /^\s*[-–—·:|/]\s*/;
const JOINED_AT_TAIL = /\s*[-–—·:|/]\s*$/;

export interface AccountLabelParts {
  /** Null when there is no institution, or when the name already says it. */
  institution: string | null;
  /** Never empty: an account called nothing but its institution keeps that. */
  name: string;
}

/**
 * The two cells a row renders — the institution, and what is left of the name
 * once a repeat of it has been taken off.
 *
 * Three things are stripped, in this order, and nothing else is:
 *
 * 1. **An exact match.** `Airwallex` at Airwallex collapses to the one word
 *    rather than to an empty leading cell, which reads as a rendering failure
 *    rather than as a fact.
 * 2. **A punctuation-joined repeat at the HEAD** — `Bitcoin Network -
 *    bc1q5n…`, so the identifying half is the half that survives truncation.
 * 3. **A punctuation-joined repeat at the TAIL** — `Ledger — Ethereum` at
 *    Ethereum. Found from the demo seed rather than from the report, which is
 *    three-for-three on this shape: naming a wallet `<device> — <chain>` is
 *    the ordinary convention, so it is the common case and not the edge one.
 *    The first version of this function handled the head alone and rendered
 *    `Ethereum · Ledger — Ethereum`.
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
    const tail = trimmedName.slice(trimmedInstitution.length);
    if (!tail.trim()) return { institution: null, name: trimmedName };
    if (JOINED_AT_HEAD.test(tail)) {
      const rest = tail.replace(JOINED_AT_HEAD, '').trim();
      if (rest) return { institution: trimmedInstitution, name: rest };
    }
  }

  if (lowerName.endsWith(lowerInstitution)) {
    const head = trimmedName.slice(0, trimmedName.length - trimmedInstitution.length);
    if (JOINED_AT_TAIL.test(head)) {
      const rest = head.replace(JOINED_AT_TAIL, '').trim();
      if (rest) return { institution: trimmedInstitution, name: rest };
    }
  }

  return { institution: trimmedInstitution, name: trimmedName };
}

/** The account, named in one string, for a sentence rather than a row. */
export function accountLabel(name: string, institution: string | null | undefined): string {
  const parts = accountLabelParts(name, institution);
  return parts.institution ? `${parts.institution} · ${parts.name}` : parts.name;
}

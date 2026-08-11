// Card-network / processor markers that precede the actual merchant name
// on a statement descriptor. Stripped so "SQ *The Coffee Shop" and "The
// Coffee Shop" normalize identically. Matched case-insensitively against
// the start of the lowercased string; only the FIRST matching prefix is
// removed (there's no legitimate case for two to stack).
const NOISE_PREFIXES = ['sq *', 'sq*', 'sp *', 'sp*', 'tst*', 'tst *', 'pp*', 'pp *', 'paypal *'];

// Collapses surface-form variance (case, punctuation, whitespace, known
// processor prefixes) so equivalent spellings of the SAME string produce
// the same key — this backs the `vendors_user_normalized_unique`
// constraint. It intentionally does NOT infer that two differently
// SPELLED strings name the same real-world vendor (e.g. "AMZN" vs
// "Amazon") — that inference is destructive if wrong and belongs to an
// explicit alias (`VendorRepository.addAlias`) or a manual `.merge`, not
// to this function.
export function normalizeVendorName(raw: string): string {
  const lowered = raw.toLowerCase().trim();

  let withoutPrefix = lowered;
  for (const prefix of NOISE_PREFIXES) {
    if (lowered.startsWith(prefix)) {
      withoutPrefix = lowered.slice(prefix.length);
      break;
    }
  }

  // Punctuation becomes a separator rather than being deleted outright —
  // deleting would collapse "Amazon.co.uk" into "amazoncouk", a single
  // run that could coincide with an unrelated name by accident.
  const collapsed = withoutPrefix
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');

  if (collapsed.length > 0) return collapsed;

  // Stripping the noise prefix ate the whole string (e.g. raw was just
  // "SQ *") — fall back to the un-stripped value so we never return "".
  return lowered
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

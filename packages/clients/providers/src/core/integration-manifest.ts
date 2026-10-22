/**
 * `IntegrationManifest` — provider-specific operational data that the
 * frontend needs to render an integration's setup flow.
 *
 * The manifest only carries data that *belongs to the provider class*:
 * how to obtain credentials and the shape of the credential form. All
 * display metadata (name, description, website, logo, category) comes
 * from the `institutions` row referenced by `institutionName` — that
 * table is the single source of truth for the institution catalog
 * (admin-editable, seeded via migrations). The api joins manifest +
 * institution at request time before returning to the frontend.
 *
 * Only credentialed providers (those implementing `CredentialValidator`)
 * carry a manifest. Pool-credentialed providers (CoinGecko, etc.) and
 * Scani-owned providers (OpenAI, …) are not user-facing for setup.
 */

type CredentialFieldType = 'text' | 'password' | 'textarea';

/**
 * Account-type codes matching the `account_types` seed rows. A provider
 * declares which type its imported accounts belong to so the import path
 * stops defaulting every integration to `crypto`.
 */
type AccountTypeCode = 'checking' | 'savings' | 'investment' | 'crypto' | 'other';

interface CredentialField {
  /** Object key in the submitted credentials map (`apiKey`, `apiSecret`, …). */
  name: string;
  /** Form-label text rendered next to the input. */
  label: string;
  /** Browser input type. `password` masks echoes; `textarea` renders multi-line. */
  type: CredentialFieldType;
  /** Whether the value is treated as a secret end-to-end (UI masking, log redaction). */
  sensitive: boolean;
  /** Whether the form blocks submission when the field is empty. */
  required: boolean;
  /** Small grey caption rendered under the input (one short sentence). */
  hint?: string;
  /** Greyed-out text inside the input before the user types. */
  placeholder?: string;
}

interface IntegrationInstructions {
  /** Ordered list rendered as `<ol>` under the form. */
  steps: string[];
  /** Optional link to upstream documentation. */
  docsUrl?: string;
  /** Optional warning rendered when the visitor is on a mobile device. */
  mobileNote?: string;
  /** A rule that applies to every step, rendered under the list. */
  note?: string;
}

export interface IntegrationManifest {
  /** Matches the provider class's `providerKey`. */
  providerKey: string;
  /**
   * Matches the `institutions.name` row this manifest belongs to. The
   * api looks up the row at request time and joins display metadata
   * (description, website, logoUrl, type) into the `listAvailable`
   * response. Boot fails loud if the manifest references a name not
   * present in the institutions table.
   */
  institutionName: string;
  /** Schema for the credential entry form. */
  credentialFields: readonly CredentialField[];
  /** Per-provider guidance on obtaining credentials. */
  instructions: IntegrationInstructions;
  /**
   * When true, the api skips calling `CredentialValidator.validateCredentials`
   * before storing + enqueuing — the worker is the sole consumer of the
   * credentials and surfaces validation errors on the job page.
   *
   * Used by IBKR's Flex Web Service: a token is rate-limited to one
   * SendRequest per minute, so a router-level pre-validate burns the
   * only call before the worker can fetch the report. Defer entirely.
   */
  skipServerValidation?: boolean;
  /**
   * Account type imported accounts for this provider are created as
   * (drives `accounts.type_id`). Defaults to `'crypto'` when unset — the
   * historical behaviour for CEX providers. Fiat/bank providers set this
   * to a bank type (`savings`, `checking`, …) so their accounts aren't
   * miscategorised as crypto (which, among other things, blocks APY
   * configuration on their holdings).
   */
  defaultAccountTypeCode?: AccountTypeCode;
  /**
   * The provider's terms allow its credential only in software the customer
   * runs themselves, so only a self-hosted install may connect it. The hosted
   * product lists it and refuses the connect (SC-1729: bunq's personal API key).
   */
  selfHostedOnly?: boolean;
  /**
   * The credential can do more than read — move money — because the provider
   * offers no read-only kind. The connect form says so before a key is pasted
   * (SC-1729: bunq keys "grant broad permissions").
   */
  credentialCanMoveMoney?: boolean;
  /**
   * Statement formats the provider exports that Scani imports. Where the
   * connector cannot be used, the notice names them, so the customer knows
   * which file to download (SC-1729: hosted bunq).
   */
  statementExportFormats?: readonly string[];
  /**
   * What the provider calls its one credential, so the connect page names it
   * the same way: "this key" or "this token". Defaults to "key". A service
   * with several credential fields says "these credentials" (SC-1732).
   */
  credentialNoun?: 'key' | 'token';
  /**
   * The longest the provider's credential lives, in days. A refused one has
   * most likely expired, so the account says so, names the lifetime and asks
   * for a new one rather than a reconnect (SC-1733: a Fio token, 180).
   */
  credentialLifetimeDays?: number;
}

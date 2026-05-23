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

export type CredentialFieldType = 'text' | 'password' | 'textarea';

export interface CredentialField {
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

export interface IntegrationInstructions {
  /** Ordered list rendered as `<ol>` under the form. */
  steps: string[];
  /** Optional link to upstream documentation. */
  docsUrl?: string;
  /** Optional warning rendered when the visitor is on a mobile device. */
  mobileNote?: string;
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
}

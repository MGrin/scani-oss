/**
 * The WebAuthn relying party for the app (SC-1646). The app's own hostname,
 * not its parent domain: a passkey is used only at the app, and the parent
 * would need a public-suffix list to compute for a self-hosted domain.
 */
export function passkeyRelyingParty(frontendUrl: string): { rpID: string; origin: string } {
  const url = new URL(frontendUrl);
  return { rpID: url.hostname, origin: url.origin };
}

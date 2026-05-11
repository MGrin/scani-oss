// Internal request header used by middleware → page handoff for
// `/auth/login`: middleware mints fresh WebAuthn options and forwards
// them on this header so the page Server Component can render them
// inline without a client-side fetch.
export const LOGIN_OPTIONS_HEADER = 'x-passkey-options';

// Canonical event names. Keep these stable — PostHog insights, funnels,
// and cohorts created by scripts/posthog-setup.ts reference them by string.
export const ANALYTICS_EVENTS = {
  emailSent: 'email_sent',
  emailOpened: 'email_opened',
  emailLinkClicked: 'email_link_clicked',
  userSignedUp: 'user_signed_up',
  accountConnected: 'account_connected',
  importCompleted: 'import_completed',
  waitlistJoined: 'waitlist_joined',
  contactSubmitted: 'contact_submitted',
} as const;

export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS];

// Which Scani surface an event originated from. Registered as a PostHog
// super property on the browser SDK and attached to server-side events so
// a single project can drive cross-app funnels.
export type AnalyticsApp = 'landing' | 'app' | 'cloud' | 'email' | 'backend';

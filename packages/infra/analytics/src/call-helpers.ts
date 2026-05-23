import crypto from 'node:crypto';
import { Container } from 'typedi';
import { loadAnalyticsConfig } from './config';
import { rewriteEmailHtml, TRANSPARENT_GIF, verifyTrackingToken } from './email-tracking';
import { ANALYTICS_EVENTS, type AnalyticsApp } from './events';
import { AnalyticsService } from './server';

// One named helper per analytics call site. Keeps the per-app divergence
// from OSS down to "one import + one helper call" so future syncs from
// upstream rarely conflict on analytics hunks.

export async function shutdownAnalytics(): Promise<void> {
  await Container.get(AnalyticsService)
    .shutdown()
    .catch(() => undefined);
}

export function captureUserSignedUp(user: { id: string; email?: string | null }): void {
  Container.get(AnalyticsService).capture({
    distinctId: user.id,
    event: ANALYTICS_EVENTS.userSignedUp,
    app: 'backend',
    properties: { email: user.email },
  });
}

export function captureAccountConnected(
  userId: string,
  manifest: { providerKey: string; institutionName: string }
): void {
  Container.get(AnalyticsService).capture({
    distinctId: userId,
    event: ANALYTICS_EVENTS.accountConnected,
    app: 'backend',
    properties: { provider: manifest.providerKey, institution: manifest.institutionName },
  });
}

export function captureExchangeImportCompleted(
  userId: string,
  provider: string,
  result: { accountsCreated: number; tokensImported: number }
): void {
  Container.get(AnalyticsService).capture({
    distinctId: userId,
    event: ANALYTICS_EVENTS.importCompleted,
    app: 'backend',
    properties: {
      kind: 'exchange',
      provider,
      accounts_created: result.accountsCreated,
      tokens_imported: result.tokensImported,
    },
  });
}

// Applies link rewrite + open pixel when email tracking is configured,
// records `email_sent`, and returns the (possibly modified) HTML plus the
// freshly minted messageId. The whole tracking pipeline collapses to one
// helper call inside EmailService.deliver().
export function applyEmailTracking(input: {
  to: string;
  template: string;
  app: AnalyticsApp;
  html: string;
}): { html: string; messageId: string } {
  const messageId = crypto.randomUUID();
  const cfg = loadAnalyticsConfig();
  let html = input.html;
  if (cfg.EMAIL_TRACKING_BASE_URL && cfg.EMAIL_TRACKING_SECRET) {
    html = rewriteEmailHtml({
      html,
      messageId,
      recipient: input.to,
      template: input.template,
      app: input.app,
      baseUrl: cfg.EMAIL_TRACKING_BASE_URL,
      secret: cfg.EMAIL_TRACKING_SECRET,
    });
  }
  Container.get(AnalyticsService).capture({
    distinctId: input.to,
    event: ANALYTICS_EVENTS.emailSent,
    app: 'email',
    properties: { template: input.template, message_id: messageId, surface: input.app },
  });
  return { html, messageId };
}

function captureEmailHit(kind: 'open' | 'click', token: string, request: Request): string | null {
  const { EMAIL_TRACKING_SECRET } = loadAnalyticsConfig();
  if (!EMAIL_TRACKING_SECRET) return null;
  const payload = verifyTrackingToken(token, EMAIL_TRACKING_SECRET);
  if (!payload) return null;
  const ip =
    request.headers.get('fly-client-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  Container.get(AnalyticsService).capture({
    distinctId: payload.e,
    event: kind === 'open' ? ANALYTICS_EVENTS.emailOpened : ANALYTICS_EVENTS.emailLinkClicked,
    app: 'email',
    properties: {
      template: payload.t,
      message_id: payload.m,
      surface: payload.a,
      ...(payload.u ? { url: payload.u } : {}),
    },
    ...(ip ? { ip } : {}),
  });
  return payload.u ?? null;
}

// HTTP handlers for the data-provider's email-tracking routes. Returning
// a Response keeps the data-provider's route registrations one-liners.
// TRANSPARENT_GIF is a Node Buffer (Uint8Array<ArrayBufferLike>); some
// downstream tsconfigs in browser-only workspaces narrow BodyInit /
// BlobPart to Uint8Array<ArrayBuffer>, so we cast through `unknown` to
// keep both Bun and DOM type-checks happy without per-workspace plumbing.
export function handleEmailOpenRequest(token: string, request: Request): Response {
  captureEmailHit('open', token, request);
  return new Response(TRANSPARENT_GIF as unknown as Uint8Array<ArrayBuffer>, {
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    },
  });
}

export function handleEmailClickRequest(
  token: string,
  request: Request,
  fallback: string
): Response {
  const dest = captureEmailHit('click', token, request);
  return new Response(null, {
    status: 302,
    headers: { Location: dest ?? fallback, 'Cache-Control': 'no-store' },
  });
}

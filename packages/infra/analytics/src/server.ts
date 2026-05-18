import { PostHog } from 'posthog-node';
import { Service } from 'typedi';
import { loadAnalyticsConfig } from './config';
import type { AnalyticsApp, AnalyticsEvent } from './events';

interface CaptureParams {
  distinctId: string;
  event: AnalyticsEvent;
  app: AnalyticsApp;
  properties?: Record<string, unknown>;
  // When set, PostHog resolves geography from this address. Pass the email
  // client / browser IP for email-tracking hits; omit for backend events
  // (the server IP carries no useful geography).
  ip?: string;
}

// Server-side PostHog capture client. No-ops when POSTHOG_KEY is unset, so
// dev / test / OSS self-host need no PostHog account.
@Service()
export class AnalyticsService {
  private client: PostHog | null = null;
  private resolved = false;

  private get posthog(): PostHog | null {
    if (this.resolved) return this.client;
    this.resolved = true;
    const { POSTHOG_KEY, POSTHOG_HOST } = loadAnalyticsConfig();
    if (POSTHOG_KEY) {
      this.client = new PostHog(POSTHOG_KEY, { host: POSTHOG_HOST });
    }
    return this.client;
  }

  capture(params: CaptureParams): void {
    const client = this.posthog;
    if (!client) return;
    client.capture({
      distinctId: params.distinctId,
      event: params.event,
      properties: {
        app: params.app,
        ...(params.ip ? { $ip: params.ip } : {}),
        ...params.properties,
      },
      disableGeoip: !params.ip,
    });
  }

  async flush(): Promise<void> {
    await this.client?.flush().catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    await this.client?.shutdown().catch(() => undefined);
  }
}

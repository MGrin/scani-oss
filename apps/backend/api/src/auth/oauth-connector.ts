import { createHash } from 'node:crypto';
import { oauthProvider } from '@better-auth/oauth-provider';
import { db } from '@scani/db/connection';
import {
  oauthAccessTokens,
  oauthClients,
  oauthConsents,
  oauthRefreshTokens,
} from '@scani/db/schema';
import { and, arrayContains, desc, eq, gt, isNull } from 'drizzle-orm';
import { Service } from 'typedi';
import { AGENT_READ_SCOPE } from './personal-access-tokens';

/**
 * Scani as an OAuth 2.1 authorization server for AI clients (SC-1615), so
 * claude.ai, ChatGPT and other MCP clients connect to `/mcp` with a sign-in and
 * a consent screen instead of a pasted token. Built on Better-Auth's
 * `@better-auth/oauth-provider`; this file holds Scani's configuration of it
 * and the two things the plugin does not: verifying its access tokens at
 * `/mcp`, and a "connected apps" list whose revoke also kills the tokens
 * (the plugin's own `delete-consent` leaves them working).
 */

export const OAUTH_ACCESS_TOKEN_PREFIX = 'scani_oat_';
const OAUTH_REFRESH_TOKEN_PREFIX = 'scani_ort_';
const OFFLINE_SCOPE = 'offline_access';
const SCOPES = [AGENT_READ_SCOPE, OFFLINE_SCOPE];
const AUTH_BASE_PATH = '/api/auth';

function mcpResourceUrl(apiBaseUrl: string): string {
  return new URL('/mcp', apiBaseUrl).href;
}

function oauthIssuer(apiBaseUrl: string): string {
  return new URL(AUTH_BASE_PATH, apiBaseUrl).href;
}

/** Where the 401 from `/mcp` sends a client to discover how to sign in. */
export function protectedResourceMetadataUrl(apiBaseUrl: string): string {
  return new URL('/.well-known/oauth-protected-resource/mcp', apiBaseUrl).href;
}

export function oauthConnectorPlugin(opts: { apiBaseUrl: string; appUrl: string }) {
  return oauthProvider({
    loginPage: new URL('/oauth/authorize', opts.appUrl).href,
    consentPage: new URL('/oauth/consent', opts.appUrl).href,
    scopes: SCOPES,
    // Opaque tokens checked against the database on every call, so a revoke
    // takes effect on the next request rather than when a JWT expires.
    disableJwtPlugin: true,
    prefix: {
      opaqueAccessToken: OAUTH_ACCESS_TOKEN_PREFIX,
      refreshToken: OAUTH_REFRESH_TOKEN_PREFIX,
    },
    // claude.ai and ChatGPT register themselves (RFC 7591) before the user
    // has signed in anywhere; the consent screen is the gate.
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    clientRegistrationDefaultScopes: SCOPES,
    // claude.ai always sends `resource` (RFC 8707); the plugin seeds this row
    // at boot and links every registered client to it.
    resources: [{ identifier: mcpResourceUrl(opts.apiBaseUrl), name: 'Scani MCP' }],
    clientRegistrationDefaultResources: [mcpResourceUrl(opts.apiBaseUrl)],
    grantTypes: ['authorization_code', 'refresh_token'],
    // Left undefined, both default to "any signed-in user may": create, edit
    // or delete any OAuth client, and disable or retune the /mcp resource.
    // Nothing in Scani manages either through these endpoints.
    clientPrivileges: () => false,
    resourcePrivileges: () => false,
  });
}

/**
 * RFC 9728 metadata for `/mcp`. The issuer has a path, so the authorization
 * server's own metadata is at `/.well-known/oauth-authorization-server/api/auth`.
 */
export function protectedResourceMetadata(apiBaseUrl: string) {
  return {
    resource: mcpResourceUrl(apiBaseUrl),
    authorization_servers: [oauthIssuer(apiBaseUrl)],
    scopes_supported: [AGENT_READ_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Scani',
  };
}

// biome-ignore lint/suspicious/noExplicitAny: the Better-Auth instance type is inferred from its plugin list
export async function authorizationServerMetadata(auth: any): Promise<unknown> {
  return auth.api.getOAuthServerConfig();
}

export interface VerifiedOAuthToken {
  tokenId: string;
  userId: string;
  scopes: string[];
}

/** The plugin's "hashed" storage: SHA-256, base64url, no padding. */
function storedForm(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

@Service()
export class OAuthAccessTokenVerifier {
  async verify(raw: string): Promise<VerifiedOAuthToken | null> {
    if (!raw.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) return null;
    const [row] = await db
      .select({
        clientId: oauthAccessTokens.clientId,
        userId: oauthAccessTokens.userId,
        scopes: oauthAccessTokens.scopes,
      })
      .from(oauthAccessTokens)
      .where(
        and(
          eq(oauthAccessTokens.token, storedForm(raw.slice(OAUTH_ACCESS_TOKEN_PREFIX.length))),
          isNull(oauthAccessTokens.revoked),
          gt(oauthAccessTokens.expiresAt, new Date()),
          arrayContains(oauthAccessTokens.scopes, [AGENT_READ_SCOPE])
        )
      )
      .limit(1);
    if (!row?.userId) return null;
    // Keyed by the connection, not the hourly token, so a refresh does not
    // reset the rate-limit window.
    return { tokenId: `oauth:${row.clientId}`, userId: row.userId, scopes: row.scopes };
  }
}

export interface ConnectedApp {
  clientId: string;
  name: string | null;
  uri: string | null;
  icon: string | null;
  scopes: string[];
  connectedAt: Date;
}

/** Settings → Connected apps: what a user has consented to, and revoking it. */
@Service()
export class ConnectedAppsService {
  async list(userId: string): Promise<ConnectedApp[]> {
    return db
      .select({
        clientId: oauthConsents.clientId,
        name: oauthClients.name,
        uri: oauthClients.uri,
        icon: oauthClients.icon,
        scopes: oauthConsents.scopes,
        connectedAt: oauthConsents.createdAt,
      })
      .from(oauthConsents)
      .innerJoin(oauthClients, eq(oauthClients.clientId, oauthConsents.clientId))
      .where(eq(oauthConsents.userId, userId))
      .orderBy(desc(oauthConsents.createdAt));
  }

  /** Removes the consent and every token it issued. False if none was this user's. */
  async revoke(userId: string, clientId: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      const consents = await tx
        .delete(oauthConsents)
        .where(and(eq(oauthConsents.userId, userId), eq(oauthConsents.clientId, clientId)))
        .returning({ id: oauthConsents.id });
      await tx
        .delete(oauthAccessTokens)
        .where(and(eq(oauthAccessTokens.userId, userId), eq(oauthAccessTokens.clientId, clientId)));
      await tx
        .delete(oauthRefreshTokens)
        .where(
          and(eq(oauthRefreshTokens.userId, userId), eq(oauthRefreshTokens.clientId, clientId))
        );
      return consents.length > 0;
    });
  }
}

/**
 * The two discovery documents an MCP client fetches before it can sign in.
 * Both sit at the origin root, outside `/api/auth`, so Better-Auth's own
 * handler never sees them.
 */
// biome-ignore lint/suspicious/noExplicitAny: Elysia's app and Better-Auth's instance types are each inferred from their chains
export function registerOAuthDiscoveryRoutes(app: any, opts: { apiBaseUrl: string; auth: any }) {
  const resource = () => protectedResourceMetadata(opts.apiBaseUrl);
  const server = () => authorizationServerMetadata(opts.auth);
  app.get('/.well-known/oauth-protected-resource', resource);
  app.get('/.well-known/oauth-protected-resource/mcp', resource);
  app.get('/.well-known/oauth-authorization-server', server);
  app.get(`/.well-known/oauth-authorization-server${AUTH_BASE_PATH}`, server);
}

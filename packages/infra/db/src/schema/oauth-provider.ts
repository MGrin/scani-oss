import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { userSessions, users } from './users';

// The tables `@better-auth/oauth-provider` reads and writes (SC-1615): Scani as
// an OAuth 2.1 authorization server, so an AI client such as claude.ai can
// connect to `/mcp` without the user pasting a token. Column keys are the
// plugin's field names, which is how the Drizzle adapter finds them; tokens
// and client secrets are stored hashed by the plugin.

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const oauthClients = pgTable(
  'oauth_client',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id').notNull().unique(),
    clientSecret: text('client_secret'),
    clientDiscoveryId: text('client_discovery_id'),
    disabled: boolean('disabled').default(false),
    skipConsent: boolean('skip_consent'),
    enableEndSession: boolean('enable_end_session'),
    subjectType: text('subject_type'),
    scopes: text('scopes').array(),
    clientCredentialsScopes: text('client_credentials_scopes').array().default([]),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    createdAt: ts('created_at'),
    updatedAt: ts('updated_at'),
    name: text('name'),
    uri: text('uri'),
    icon: text('icon'),
    contacts: text('contacts').array(),
    tos: text('tos'),
    policy: text('policy'),
    softwareId: text('software_id'),
    softwareVersion: text('software_version'),
    softwareStatement: text('software_statement'),
    redirectUris: text('redirect_uris').array().notNull(),
    postLogoutRedirectUris: text('post_logout_redirect_uris').array(),
    backchannelLogoutUri: text('backchannel_logout_uri'),
    backchannelLogoutSessionRequired: boolean('backchannel_logout_session_required'),
    tokenEndpointAuthMethod: text('token_endpoint_auth_method'),
    applicationType: text('application_type'),
    jwks: text('jwks'),
    jwksUri: text('jwks_uri'),
    grantTypes: text('grant_types').array(),
    responseTypes: text('response_types').array(),
    requirePKCE: boolean('require_pkce'),
    dpopBoundAccessTokens: boolean('dpop_bound_access_tokens').default(false),
    referenceId: text('reference_id'),
    metadata: jsonb('metadata'),
  },
  (t) => ({
    userIdIdx: index('idx_oauth_client_user_id').on(t.userId),
  })
);

export const oauthResources = pgTable('oauth_resource', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull().unique(),
  name: text('name').notNull(),
  accessTokenTtl: integer('access_token_ttl'),
  refreshTokenTtl: integer('refresh_token_ttl'),
  signingAlgorithm: text('signing_algorithm'),
  signingKeyId: text('signing_key_id'),
  allowedScopes: text('allowed_scopes').array(),
  customClaims: jsonb('custom_claims'),
  dpopBoundAccessTokensRequired: boolean('dpop_bound_access_tokens_required').default(false),
  disabled: boolean('disabled').default(false),
  createdAt: ts('created_at'),
  updatedAt: ts('updated_at'),
  policyVersion: integer('policy_version').default(1),
  metadata: jsonb('metadata'),
});

export const oauthClientResources = pgTable(
  'oauth_client_resource',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    resourceId: text('resource_id')
      .notNull()
      .references(() => oauthResources.identifier, { onDelete: 'cascade' }),
    metadata: jsonb('metadata'),
    createdAt: ts('created_at'),
  },
  (t) => ({
    clientResourceUq: uniqueIndex('uq_oauth_client_resource_client_resource').on(
      t.clientId,
      t.resourceId
    ),
    resourceIdx: index('idx_oauth_client_resource_resource_id').on(t.resourceId),
  })
);

export const oauthRefreshTokens = pgTable(
  'oauth_refresh_token',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => userSessions.id, { onDelete: 'set null' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    referenceId: text('reference_id'),
    authorizationCodeId: text('authorization_code_id'),
    resources: text('resources').array(),
    requestedUserInfoClaims: text('requested_user_info_claims').array(),
    expiresAt: ts('expires_at').notNull(),
    createdAt: ts('created_at').notNull(),
    revoked: ts('revoked'),
    rotatedAt: ts('rotated_at'),
    rotationReplayResponse: text('rotation_replay_response'),
    rotationReplayExpiresAt: ts('rotation_replay_expires_at'),
    authTime: ts('auth_time'),
    confirmation: jsonb('confirmation'),
    scopes: text('scopes').array().notNull(),
  },
  (t) => ({
    clientIdx: index('idx_oauth_refresh_token_client_id').on(t.clientId),
    userIdx: index('idx_oauth_refresh_token_user_id').on(t.userId),
    sessionIdx: index('idx_oauth_refresh_token_session_id').on(t.sessionId),
    codeIdx: index('idx_oauth_refresh_token_authorization_code_id').on(t.authorizationCodeId),
  })
);

export const oauthAccessTokens = pgTable(
  'oauth_access_token',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => userSessions.id, { onDelete: 'set null' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    referenceId: text('reference_id'),
    authorizationCodeId: text('authorization_code_id'),
    resources: text('resources').array(),
    requestedUserInfoClaims: text('requested_user_info_claims').array(),
    refreshId: text('refresh_id').references(() => oauthRefreshTokens.id, {
      onDelete: 'cascade',
    }),
    expiresAt: ts('expires_at').notNull(),
    createdAt: ts('created_at').notNull(),
    revoked: ts('revoked'),
    confirmation: jsonb('confirmation'),
    scopes: text('scopes').array().notNull(),
  },
  (t) => ({
    clientIdx: index('idx_oauth_access_token_client_id').on(t.clientId),
    userIdx: index('idx_oauth_access_token_user_id').on(t.userId),
    sessionIdx: index('idx_oauth_access_token_session_id').on(t.sessionId),
    codeIdx: index('idx_oauth_access_token_authorization_code_id').on(t.authorizationCodeId),
    refreshIdx: index('idx_oauth_access_token_refresh_id').on(t.refreshId),
  })
);

export const oauthConsents = pgTable(
  'oauth_consent',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    referenceId: text('reference_id'),
    resources: text('resources').array(),
    requestedUserInfoClaims: text('requested_user_info_claims').array(),
    scopes: text('scopes').array().notNull(),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => ({
    clientIdx: index('idx_oauth_consent_client_id').on(t.clientId),
    userIdx: index('idx_oauth_consent_user_id').on(t.userId),
  })
);

export const oauthClientAssertions = pgTable('oauth_client_assertion', {
  id: text('id').primaryKey(),
  expiresAt: ts('expires_at').notNull(),
});

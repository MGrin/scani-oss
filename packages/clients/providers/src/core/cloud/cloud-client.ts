/**
 * `CloudProviderClient` — minimum interface every cloud-mode adapter
 * speaks against. Wired at boot time from the app's typed
 * `@scani/cloud-client` (which speaks tRPC to the data-provider).
 *
 * Defining the surface here as an interface, rather than importing
 * `@scani/cloud-client` directly, gives us:
 *
 *   1. **No build-time coupling** between `@scani/providers` and the
 *      tRPC types from `@scani/data-provider`. The cloud-mode adapter
 *      is shaped by the *contract*, not by whichever set of routers
 *      the data-provider happens to expose this week.
 *
 *   2. **Testability.** Tests substitute a mock client implementing
 *      this interface, no tRPC plumbing required.
 *
 *   3. **Tree-shakability.** Direct mode never imports this file —
 *      `buildProviderRegistry({ mode: 'direct' })` skips the cloud
 *      branch and the bundler drops the whole tree.
 *
 * The methods correspond 1:1 to the capabilities a cloud adapter
 * offers. Each takes plain JSON-shaped args (no Drizzle types — the
 * wire layer is transport-agnostic) and returns the matching
 * capability-typed result. The app's wire-up (in Task #53) translates
 * these into tRPC procedure calls under `pricing.*`, `chains.*`,
 * `ai.*`, and `tokens.*` namespaces.
 */

import type { NewToken, Token, TokenMetadata } from '@scani/db/schema';
import type { HoldingSnapshot, PriceQuote, TransactionEvent } from '../types';

export interface CloudProviderClient {
  // ============================================================
  // Pricing
  // ============================================================
  fetchCurrentPrice(args: {
    providerKey: string;
    token: Token;
    baseCurrencyId: string;
  }): Promise<PriceQuote | null>;

  fetchCurrentPrices(args: {
    providerKey: string;
    tokens: Token[];
    baseCurrencyId: string;
  }): Promise<Array<{ tokenId: string; quote: PriceQuote }>>;

  fetchHistoricalPrice(args: {
    providerKey: string;
    token: Token;
    at: Date;
    baseCurrencyId: string;
  }): Promise<PriceQuote | null>;

  fetchHistoricalRange(args: {
    providerKey: string;
    token: Token;
    from: Date;
    to: Date;
    baseCurrencyId: string;
  }): Promise<PriceQuote[]>;

  // ============================================================
  // Balances + transactions (self-credentialed)
  // ============================================================
  fetchBalances(args: {
    institutionCode: string;
    userId: string;
    institutionId: string;
    baseCurrencyId: string;
    accountId?: string;
  }): Promise<HoldingSnapshot[]>;

  fetchTransactions(args: {
    institutionCode: string;
    userId: string;
    institutionId: string;
    baseCurrencyId: string;
    accountId?: string;
    since?: Date;
    until?: Date;
  }): Promise<TransactionEvent[]>;

  // ============================================================
  // Token identity enrichment
  // ============================================================
  enrichTokenIdentity(args: {
    providerKey: string;
    partial: Partial<NewToken>;
    force?: boolean;
  }): Promise<Partial<TokenMetadata> | null>;

  // ============================================================
  // AI
  // ============================================================
  parseScreenshot(args: {
    providerKey: string;
    imageBase64: string;
    mimeType: string;
    hint?: string;
  }): Promise<unknown>;

  parseDocumentText(args: { providerKey: string; text: string; hint?: string }): Promise<unknown>;

  completeText(args: {
    providerKey: string;
    prompt: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<string>;
}

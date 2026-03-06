/**
 * x402 Payment Middleware for Scani MCP Server
 *
 * Implements the x402 payment protocol (https://x402.org / Coinbase CDP) enabling
 * autonomous AI agents to pay per-tool usage with USDC on Base network.
 *
 * Protocol flow (per x402 spec):
 *   1. Agent calls an MCP tool without the PAYMENT-SIGNATURE header
 *   2. Server responds 402 with payment requirements in the PAYMENT-REQUIRED header
 *   3. Agent constructs an EIP-3009 transferWithAuthorization signature over USDC
 *   4. Agent retries the request with PAYMENT-SIGNATURE header containing the signed payload
 *   5. Server calls the x402 facilitator /verify endpoint to verify the payment
 *   6. Server calls the x402 facilitator /settle endpoint to settle the payment on-chain
 *   7. If valid, server processes the request
 *
 * Facilitator:
 *   We delegate payment verification to the x402 facilitator, which handles:
 *   - Signature validation (EIP-3009 / transferWithAuthorization)
 *   - On-chain settlement (broadcasts the USDC transfer)
 *   - Gas sponsorship (facilitator pays gas – neither buyer nor seller needs native tokens)
 *
 *   Default:    https://x402.org/facilitator     (testnet, no auth required)
 *   Production: https://api.cdp.coinbase.com/platform/v2/x402 (CDP, requires API keys)
 *
 * Environment variables:
 *   SCANI_WALLET_ADDRESS     - Base/EVM wallet address that receives USDC payments (required)
 *   X402_FACILITATOR_URL     - Facilitator base URL (default: https://x402.org/facilitator)
 *   X402_NETWORK             - CAIP-2 network ID (default: eip155:8453 = Base mainnet,
 *                              use eip155:84532 for Base Sepolia testnet)
 */

import { db } from '@scani/core/database/connection';
import * as schema from '@scani/core/database/schema';
import { createComponentLogger } from '@scani/core/utils/logger';
import { eq, sql } from 'drizzle-orm';

const logger = createComponentLogger('mcp:x402');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** USDC contract address on Base mainnet */
const USDC_BASE_MAINNET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
/** USDC contract address on Base Sepolia testnet */
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

/** x402 protocol version */
export const X402_VERSION = 1;

/**
 * Default facilitator URL – x402.org testnet (no auth required).
 * Override with X402_FACILITATOR_URL env var.
 * For production, use: https://api.cdp.coinbase.com/platform/v2/x402
 */
export const DEFAULT_FACILITATOR_URL = 'https://x402.org/facilitator';

/** x402 standard HTTP header names */
export const X402_HEADERS = {
  /** Sent by the server in 402 responses with payment requirements (base64-encoded JSON) */
  PAYMENT_REQUIRED: 'X-PAYMENT-REQUIRED',
  /** Sent by the client with the signed payment payload (base64-encoded JSON) */
  PAYMENT_SIGNATURE: 'X-PAYMENT-SIGNATURE',
} as const;

/** Returns the configured CAIP-2 network ID (default: Base mainnet) */
export function getNetwork(): string {
  return process.env.X402_NETWORK ?? 'eip155:8453';
}

/** Returns the USDC contract address for the configured network */
export function getUsdcAddress(): string {
  const network = getNetwork();
  return network === 'eip155:84532' ? USDC_BASE_SEPOLIA : USDC_BASE_MAINNET;
}

/** Returns the configured facilitator URL */
export function getFacilitatorUrl(): string {
  return process.env.X402_FACILITATOR_URL ?? DEFAULT_FACILITATOR_URL;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pricing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tool pricing configuration
 * Costs are in USDC micro-units (6 decimals):
 *   1_000_000 = $1.00 USDC
 *     100_000 = $0.10 USDC
 *      40_000 = $0.04 USDC
 */
interface PaidToolConfig {
  toolName: string;
  /** Pricing strategy:
   *  'fixed'    - static price every time
   *  'creation' - free within free-tier limits, charged above
   *  'reading'  - free within free-tier limits, charged above
   */
  type: 'creation' | 'reading' | 'fixed';
  /** Cost in USDC micro-units for fixed-price tools */
  baseCost?: number;
}

/** USDC amounts in micro-units (6 decimals, matching ERC-20 standard) */
export const USDC_AMOUNTS = {
  /** $0.04 - aggregate reads when over free-tier limits */
  READING_OVER_LIMIT: 40_000,
  /** $0.10 - creation when over free-tier limits */
  CREATION_OVER_LIMIT: 100_000,
  /** $0.10 - Binance/Kraken integration setup */
  INTEGRATION_SETUP: 100_000,
  /** $0.15 - AI screenshot parse */
  SCREENSHOT_PARSE: 150_000,
  /** $0.50 - wallet import (blockchain data enrichment) */
  WALLET_IMPORT: 500_000,
} as const;

/** Free-tier limits per user */
export const FREE_TIER = {
  /** Max accounts before aggregate reads/creation is charged */
  MAX_ACCOUNTS: 3,
  /** Max holdings per account before aggregate reads/creation is charged */
  MAX_HOLDINGS_PER_ACCOUNT: 10,
} as const;

/**
 * Tool pricing table.
 * Tools NOT listed here are always free.
 *
 * NOTE: Only tools that are actually registered as MCP tools (via server.registerTool)
 * should be listed here. Entries for unregistered tools are harmless (the payment check
 * will never be reached for a tool that doesn't exist), but they add confusion.
 */
const PAID_TOOLS: PaidToolConfig[] = [
  // --- Creation tools (free within free-tier, charged above) ---
  { toolName: 'accounts_create', type: 'creation' },
  { toolName: 'holdings_create', type: 'creation' },
  { toolName: 'institutions_create', type: 'creation' },

  // --- Fixed-price tools (always charged) ---
  { toolName: 'wallet_importAddress', type: 'fixed', baseCost: USDC_AMOUNTS.WALLET_IMPORT },
  {
    toolName: 'screenshots_parse',
    type: 'fixed',
    baseCost: USDC_AMOUNTS.SCREENSHOT_PARSE,
  },
  {
    toolName: 'integrations_binance_validateKeys',
    type: 'fixed',
    baseCost: USDC_AMOUNTS.INTEGRATION_SETUP,
  },
  {
    toolName: 'integrations_kraken_validateKeys',
    type: 'fixed',
    baseCost: USDC_AMOUNTS.INTEGRATION_SETUP,
  },

  // --- Aggregate reading tools (free within free-tier, charged above) ---
  { toolName: 'dashboard_getOverview', type: 'reading' },
  { toolName: 'dashboard_getAssetAllocation', type: 'reading' },
  { toolName: 'accounts_getAll', type: 'reading' },
  { toolName: 'accounts_getByUserIdWithSummary', type: 'reading' },
  { toolName: 'holdings_getWithDetails', type: 'reading' },
  { toolName: 'holdings_getCommonGroups', type: 'reading' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * x402 PaymentRequirements object (sent in 402 response PAYMENT-REQUIRED header).
 * Matches the x402 spec: https://x402.org
 */
export interface X402PaymentRequirements {
  /** x402 protocol version number */
  x402Version: number;
  /** Array of accepted payment options */
  accepts: Array<{
    /** Payment scheme ("exact" = EIP-3009 transferWithAuthorization) */
    scheme: 'exact';
    /** CAIP-2 network identifier (e.g. "eip155:8453" for Base mainnet) */
    network: string;
    /** Amount required in USDC micro-units (6 decimals) as a string */
    maxAmountRequired: string;
    /** URL of the resource being accessed */
    resource: string;
    /** Human-readable description of what is being paid for */
    description: string;
    /** Response MIME type */
    mimeType: string;
    /** EVM address to receive payment */
    payTo: string;
    /** Max seconds the payment is valid for before expiring */
    maxTimeoutSeconds: number;
    /** USDC ERC-20 contract address */
    asset: string;
    /** Extra metadata */
    extra?: Record<string, unknown>;
  }>;
}

/**
 * x402 PaymentPayload (sent in PAYMENT-SIGNATURE header by the client).
 * Contains the EIP-3009 signed authorization for a USDC transfer.
 */
export interface X402PaymentPayload {
  /** x402 protocol version */
  x402Version: number;
  /** Payment scheme */
  scheme: 'exact';
  /** CAIP-2 network identifier */
  network: string;
  /** EIP-3009 authorization payload */
  payload: {
    signature: string;
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
  };
}

/** Facilitator /verify response */
interface FacilitatorVerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

/** Facilitator /settle response */
interface FacilitatorSettleResponse {
  success: boolean;
  txHash?: string;
  error?: string;
}

/** Result of the x402 payment check */
export type X402CheckResult =
  | { required: false }
  | { required: true; requirements: X402PaymentRequirements };

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check whether a tool call requires payment for the given user.
 *
 * Returns `{ required: false }` when:
 *   - the tool is not in the paid list
 *   - the user is within free-tier limits
 *   - a valid payment proof is present in the PAYMENT-SIGNATURE header
 *
 * Returns `{ required: true, requirements }` when payment is needed but
 * missing or invalid – the caller should issue an HTTP 402 response.
 */
export async function checkX402Payment(
  toolName: string,
  request: Request,
  userId: string
): Promise<X402CheckResult> {
  const toolConfig = PAID_TOOLS.find((t) => t.toolName === toolName);

  // Tool not in paid list – always free
  if (!toolConfig) {
    return { required: false };
  }

  const cost = await calculateCost(toolConfig, userId);

  // Within free tier – no payment needed
  if (cost === 0) {
    return { required: false };
  }

  const requirements = buildPaymentRequirements(toolName, cost);

  // Check for payment signature header (x402 spec)
  const paymentSignature = request.headers.get(X402_HEADERS.PAYMENT_SIGNATURE);

  if (!paymentSignature) {
    logger.debug({ toolName, userId, cost }, 'x402 payment required – no signature header present');
    return { required: true, requirements };
  }

  // Parse payment payload
  const payload = parsePaymentPayload(paymentSignature);
  if (!payload) {
    logger.warn({ toolName, userId }, 'x402 payment signature present but invalid format');
    return { required: true, requirements };
  }

  // Verify via facilitator
  const isValid = await verifyWithFacilitator(payload, requirements);
  if (!isValid) {
    logger.warn({ toolName, userId }, 'x402 payment verification failed via facilitator');
    return { required: true, requirements };
  }

  // Settle via facilitator (async – fire and forget for latency, but log errors)
  settleWithFacilitator(payload, requirements).catch((err: unknown) => {
    logger.error(
      { toolName, userId, error: err instanceof Error ? err.message : String(err) },
      '⚠️ x402 payment settlement failed – payment was verified but not settled'
    );
  });

  logger.info({ toolName, userId, cost }, '✅ x402 payment verified and settlement initiated');
  return { required: false };
}

/**
 * Build an HTTP 402 Payment Required response.
 * Sets both the JSON-RPC error body and the standard PAYMENT-REQUIRED header.
 */
export function createX402Response(
  requirements: X402PaymentRequirements,
  requestId: string | number | null = null
): Response {
  // Encode requirements as base64 for the PAYMENT-REQUIRED header
  const paymentRequiredHeader = Buffer.from(JSON.stringify(requirements)).toString('base64');

  const [accept] = requirements.accepts;
  const amountFormatted = accept ? (Number(accept.maxAmountRequired) / 1_000_000).toFixed(6) : '?';
  const toolName = accept?.description?.split(' ').at(-1) ?? 'tool';

  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: -32402,
        message: `Payment required: ${amountFormatted} USDC on Base for ${toolName}`,
        data: {
          x402Version: requirements.x402Version,
          paymentRequired: requirements,
        },
      },
      id: requestId,
    }),
    {
      status: 402,
      headers: {
        'Content-Type': 'application/json',
        [X402_HEADERS.PAYMENT_REQUIRED]: paymentRequiredHeader,
      },
    }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Cost calculation
// ─────────────────────────────────────────────────────────────────────────────

async function calculateCost(config: PaidToolConfig, userId: string): Promise<number> {
  switch (config.type) {
    case 'fixed':
      return config.baseCost ?? 0;
    case 'creation':
      return calculateCreationCost(config.toolName, userId);
    case 'reading':
      return calculateReadingCost(userId);
    default:
      return 0;
  }
}

/**
 * Creation tools are free until the user hits the free-tier account/holding limits.
 */
async function calculateCreationCost(toolName: string, userId: string): Promise<number> {
  if (toolName === 'accounts_create') {
    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.accounts)
      .where(eq(schema.accounts.userId, userId));

    return Number(row?.count ?? 0) >= FREE_TIER.MAX_ACCOUNTS ? USDC_AMOUNTS.CREATION_OVER_LIMIT : 0;
  }

  if (toolName === 'holdings_create') {
    // The cost is charged based on the total holdings across ALL accounts at the user level.
    // Since the MCP tool call doesn't pass the target accountId at the payment-check stage
    // (the check happens before the tool executes), we use a conservative rule:
    // charge if ANY account already has ≥ MAX_HOLDINGS_PER_ACCOUNT holdings.
    const accounts = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.userId, userId));

    for (const account of accounts) {
      const [row] = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.holdings)
        .where(eq(schema.holdings.accountId, account.id));

      if (Number(row?.count ?? 0) >= FREE_TIER.MAX_HOLDINGS_PER_ACCOUNT) {
        return USDC_AMOUNTS.CREATION_OVER_LIMIT;
      }
    }

    return 0;
  }

  return 0;
}

/**
 * Aggregate reading tools are free while the user stays within free-tier limits.
 */
async function calculateReadingCost(userId: string): Promise<number> {
  const withinFreeTier = await isUserWithinFreeTier(userId);
  return withinFreeTier ? 0 : USDC_AMOUNTS.READING_OVER_LIMIT;
}

/**
 * Return true when the user is within the free tier:
 *   ≤ MAX_ACCOUNTS accounts, each with ≤ MAX_HOLDINGS_PER_ACCOUNT holdings.
 */
export async function isUserWithinFreeTier(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(schema.accounts)
    .where(eq(schema.accounts.userId, userId));

  if (Number(row?.count ?? 0) > FREE_TIER.MAX_ACCOUNTS) return false;

  const accounts = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(eq(schema.accounts.userId, userId));

  for (const account of accounts) {
    const [hrow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.holdings)
      .where(eq(schema.holdings.accountId, account.id));

    if (Number(hrow?.count ?? 0) > FREE_TIER.MAX_HOLDINGS_PER_ACCOUNT) return false;
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Payment requirements builder
// ─────────────────────────────────────────────────────────────────────────────

function buildPaymentRequirements(toolName: string, cost: number): X402PaymentRequirements {
  const recipient = process.env.SCANI_WALLET_ADDRESS;
  if (!recipient) {
    logger.error('SCANI_WALLET_ADDRESS env var not set – cannot accept x402 payments');
  }

  const backendUrl = process.env.BACKEND_URL ?? 'https://api.scani.xyz';
  const network = getNetwork();
  const usdcAddress = getUsdcAddress();

  return {
    x402Version: X402_VERSION,
    accepts: [
      {
        scheme: 'exact',
        network,
        maxAmountRequired: cost.toString(),
        resource: `${backendUrl}/mcp`,
        description: `${(cost / 1_000_000).toFixed(6)} USDC required on Base to call ${toolName}`,
        mimeType: 'application/json',
        payTo: recipient ?? '0x0000000000000000000000000000000000000000',
        maxTimeoutSeconds: 300,
        asset: usdcAddress,
        extra: { name: 'USDC', version: '2' },
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Payment payload parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse the base64-encoded JSON payment payload from the PAYMENT-SIGNATURE header.
 * The payload must be a valid x402 PaymentPayload object.
 */
export function parsePaymentPayload(header: string): X402PaymentPayload | null {
  try {
    // Guard against oversized payloads (max 8 KB)
    if (header.length > 8_000) {
      logger.warn({ headerLength: header.length }, 'PAYMENT-SIGNATURE header too large, rejecting');
      return null;
    }
    const decoded = Buffer.from(header, 'base64').toString('utf-8');
    const payload = JSON.parse(decoded) as Partial<X402PaymentPayload>;

    if (
      typeof payload.x402Version !== 'number' ||
      payload.scheme !== 'exact' ||
      typeof payload.network !== 'string' ||
      typeof payload.payload !== 'object' ||
      payload.payload === null
    ) {
      return null;
    }

    return payload as X402PaymentPayload;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Facilitator integration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify a payment payload via the x402 facilitator.
 * Returns true if the payment is valid according to the facilitator.
 */
async function verifyWithFacilitator(
  payload: X402PaymentPayload,
  requirements: X402PaymentRequirements
): Promise<boolean> {
  const facilitatorUrl = getFacilitatorUrl();

  // Find the matching payment requirement for the payload's network
  const matchingReq = requirements.accepts.find((r) => r.network === payload.network);
  if (!matchingReq) {
    logger.warn({ network: payload.network }, 'No payment requirement for payload network');
    return false;
  }

  try {
    const res = await fetch(`${facilitatorUrl}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        x402Version: payload.x402Version,
        paymentPayload: payload,
        paymentRequirements: matchingReq,
      }),
    });

    const data = (await res.json()) as FacilitatorVerifyResponse;

    if (res.status !== 200 || !data.isValid) {
      logger.warn(
        { status: res.status, reason: data.invalidReason, facilitatorUrl },
        'Facilitator rejected payment'
      );
      return false;
    }

    logger.debug({ facilitatorUrl, payer: data.payer }, 'Facilitator verified payment');
    return true;
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error), facilitatorUrl },
      'Failed to contact x402 facilitator for verification'
    );
    return false;
  }
}

/**
 * Settle a payment via the x402 facilitator.
 * The facilitator broadcasts the USDC transferWithAuthorization on-chain.
 * Called after successful verification.
 */
async function settleWithFacilitator(
  payload: X402PaymentPayload,
  requirements: X402PaymentRequirements
): Promise<void> {
  const facilitatorUrl = getFacilitatorUrl();
  const matchingReq = requirements.accepts.find((r) => r.network === payload.network);
  if (!matchingReq) return;

  const res = await fetch(`${facilitatorUrl}/settle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      x402Version: payload.x402Version,
      paymentPayload: payload,
      paymentRequirements: matchingReq,
    }),
  });

  const data = (await res.json()) as FacilitatorSettleResponse;

  if (res.status !== 200 || !data.success) {
    throw new Error(
      `Facilitator settlement failed (${res.status}): ${data.error ?? 'unknown error'}`
    );
  }

  logger.info({ txHash: data.txHash, facilitatorUrl }, '💸 x402 payment settled on-chain');
}

/**
 * blockchainConfigs.ts
 *
 * Declarative configuration for all blockchain integrations
 *
 * NOTE: Blockchain integrations are created through the legacy database-backed
 * chain mapping system (InstitutionBlockchainMappingRepository) for backwards
 * compatibility. This file documents the available blockchain integrations,
 * but they are not registered in the primary registry.
 *
 * New integration types (exchanges, brokers, banks) should use the registry
 * pattern directly via IntegrationRegistry.
 */

// NOTE: Blockchain integrations are created through the legacy database-backed
// chain mapping system (InstitutionBlockchainMappingRepository) for backwards
// compatibility. These configs are for reference/documentation only.
// The createIntegration functions throw errors - do not use in production.

// biome-ignore lint/suspicious/noExplicitAny: Factory returns function that throws
const createBlockchainIntegration = (name: string): any => {
  return () => {
    throw new Error(
      `${name} is for reference only. Use the registry-based system or database mapping instead.`
    );
  };
};

import type { IntegrationConfig } from '../registry/IntegrationRegistry';

/**
 * Note: These configurations document the blockchain integrations but
 * are not actively used. They remain for reference and future migration
 * to the registry-based system.
 */

/**
 * Ethereum blockchain configuration
 */
export const ethereumConfig: IntegrationConfig = {
  institutionId: 'ethereum',
  type: 'blockchain',
  authType: 'manual',
  name: 'Ethereum',
  createIntegration: createBlockchainIntegration('Ethereum'),
  metadata: {
    chainId: 1,
    symbol: 'ETH',
  },
};

/**
 * Bitcoin blockchain configuration
 */
export const bitcoinConfig: IntegrationConfig = {
  institutionId: 'bitcoin',
  type: 'blockchain',
  authType: 'manual',
  name: 'Bitcoin',
  createIntegration: createBlockchainIntegration('Bitcoin'),
  metadata: {
    chainId: 0,
    symbol: 'BTC',
  },
};

/**
 * Solana blockchain configuration
 */
export const solanaConfig: IntegrationConfig = {
  institutionId: 'solana',
  type: 'blockchain',
  authType: 'manual',
  name: 'Solana',
  createIntegration: createBlockchainIntegration('Solana'),
  metadata: {
    chainId: 101,
    symbol: 'SOL',
  },
};

/**
 * Polygon blockchain configuration
 */
export const polygonConfig: IntegrationConfig = {
  institutionId: 'polygon',
  type: 'blockchain',
  authType: 'manual',
  name: 'Polygon',
  createIntegration: createBlockchainIntegration('Polygon'),
  metadata: {
    chainId: 137,
    symbol: 'MATIC',
  },
};

/**
 * Arbitrum blockchain configuration
 */
export const arbitrumConfig: IntegrationConfig = {
  institutionId: 'arbitrum',
  type: 'blockchain',
  authType: 'manual',
  name: 'Arbitrum',
  createIntegration: createBlockchainIntegration('Arbitrum'),
  metadata: {
    chainId: 42161,
    symbol: 'ARB',
  },
};

/**
 * Optimism blockchain configuration
 */
export const optimismConfig: IntegrationConfig = {
  institutionId: 'optimism',
  type: 'blockchain',
  authType: 'manual',
  name: 'Optimism',
  createIntegration: createBlockchainIntegration('Optimism'),
  metadata: {
    chainId: 10,
    symbol: 'OP',
  },
};

/**
 * All blockchain integrations
 */
export const blockchainConfigs: IntegrationConfig[] = [
  ethereumConfig,
  bitcoinConfig,
  solanaConfig,
  polygonConfig,
  arbitrumConfig,
  optimismConfig,
];

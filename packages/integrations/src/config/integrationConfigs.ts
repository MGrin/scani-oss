/**
 * integrationConfigs.ts
 *
 * Central point for all non-blockchain integration configurations.
 * Consolidates exchanges, brokers, banks, payment providers, and other integrations.
 *
 * NOTE: Blockchain integrations remain on the legacy database-backed system
 * (InstitutionBlockchainMappingRepository) for backwards compatibility.
 * They are not included in this registry-based system.
 *
 * All NEW integration types should be added here and will be automatically
 * registered in the IntegrationManager on startup.
 */

import type { IntegrationConfig } from '../registry/IntegrationRegistry';
import { exchangeConfigs } from './exchangeConfigs';

/**
 * All integration configurations for the registry system
 * This includes all non-blockchain integrations (exchanges, brokers, banks, etc.)
 *
 * Blockchain integrations use the legacy database mapping system for backwards compatibility.
 */
export const allIntegrationConfigs: IntegrationConfig[] = [
  ...exchangeConfigs,
  // Future integration type configs:
  // ...brokerConfigs,
  // ...bankConfigs,
  // ...paymentConfigs,
];

export { exchangeConfigs };

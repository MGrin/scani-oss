/**
 * IntegrationRegistry
 *
 * Central registry for all institution integrations (blockchains, exchanges, brokers, etc.)
 * Provides a clean, extensible way to register and retrieve integrations.
 */

import { createComponentLogger } from '@scani/core/utils/logger';

import type { ScaniIntegration } from '../base';

const logger = createComponentLogger('integration-registry');

/**
 * Integration type classification
 */
export type IntegrationType = 'blockchain' | 'exchange' | 'broker' | 'bank' | 'payment' | 'other';

/**
 * Configuration for registering an integration
 */
export interface IntegrationConfig {
  /** Unique institution ID */
  institutionId: string;

  /** Type of integration (blockchain, exchange, etc.) */
  type: IntegrationType;

  /** Authentication type required */
  authType: 'oauth' | 'api_key' | 'rpc' | 'credentials' | 'manual';

  /** Human-readable name */
  name: string;

  /** Factory function to create the integration instance */
  createIntegration: () => ScaniIntegration;

  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Global integration registry
 * Manages all available integrations in the system
 */
class IntegrationRegistry {
  private readonly integrations = new Map<string, IntegrationConfig>();

  /**
   * Register an integration
   */
  register(config: IntegrationConfig): void {
    if (this.integrations.has(config.institutionId)) {
      logger.warn(
        { institutionId: config.institutionId, newName: config.name },
        'Integration already registered, overwriting'
      );
    }

    this.integrations.set(config.institutionId, config);
    logger.debug(
      { institutionId: config.institutionId, name: config.name, type: config.type },
      'Integration registered'
    );
  }

  /**
   * Get integration config by institution ID
   */
  get(institutionId: string): IntegrationConfig | null {
    return this.integrations.get(institutionId) || null;
  }

  /**
   * Create integration instance by institution ID
   */
  createIntegration(institutionId: string): ScaniIntegration | null {
    const config = this.get(institutionId);
    if (!config) {
      logger.debug({ institutionId }, 'Integration not found in registry');
      return null;
    }

    try {
      const integration = config.createIntegration();
      logger.debug({ institutionId, name: config.name }, 'Integration instance created');
      return integration;
    } catch (error) {
      logger.error(
        {
          institutionId,
          name: config.name,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to create integration instance'
      );
      return null;
    }
  }

  /**
   * Get all registered integrations
   */
  getAll(): IntegrationConfig[] {
    return Array.from(this.integrations.values());
  }

  /**
   * Get all integrations of a specific type
   */
  getByType(type: IntegrationType): IntegrationConfig[] {
    return this.getAll().filter((config) => config.type === type);
  }

  /**
   * Check if an integration is registered
   */
  has(institutionId: string): boolean {
    return this.integrations.has(institutionId);
  }

  /**
   * Get total number of registered integrations
   */
  size(): number {
    return this.integrations.size;
  }

  /**
   * Get all institution IDs
   */
  getInstitutionIds(): string[] {
    return Array.from(this.integrations.keys());
  }

  /**
   * Clear all registrations (useful for testing)
   */
  clear(): void {
    this.integrations.clear();
    logger.debug('Integration registry cleared');
  }
}

/**
 * Global singleton registry instance
 */
export const integrationRegistry = new IntegrationRegistry();

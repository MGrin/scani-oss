import 'reflect-metadata';
import { createComponentLogger } from '@scani/core';
import { Container } from 'typedi';

// Import all repositories to ensure they're registered with TypeDI
// This loads all @Service() decorated classes from the core package
import '@scani/core/repositories';

// Import all services to ensure they're registered with TypeDI
// This loads all @Service() decorated classes from the core package
import '@scani/core/services';

// Import backend-specific services
import '../infrastructure/telegram/TelegramAuthService';

const containerLogger = createComponentLogger('container');

/**
 * Initialize the Dependency Injection Container
 * This must be called before any service instantiation
 *
 * How TypeDI Registration Works:
 * - All classes decorated with @Service() are automatically registered
 * - Importing the index files (repositories, services) ensures all classes are loaded
 * - Once loaded, TypeDI can inject them via Container.get()
 * - The @Service() decorator makes classes singleton by default
 *
 * Registered Services (from @scani/core/services):
 * - AccountService, AIService, BaseService, DashboardService
 * - HoldingService, InstitutionService, PortfolioValuationService
 * - PricingService, TokenService, TokenValidationService
 * - UserContextService, UserService
 * - AccountTypeService, InstitutionTypeService (EnumServices)
 *
 * Backend-Specific Services:
 * - TelegramAuthService (uses TRPCError, backend-only)
 *
 * Registered Repositories (from @scani/core/repositories):
 * - AccountRepository, BaseRepository, HoldingRepository
 * - InstitutionRepository, TelegramUserRepository, TokenRepository
 * - TokenPriceRepository, UserRepository
 * - AccountTypeRepository, InstitutionTypeRepository, TokenTypeRepository (Enums)
 *
 * Registered Use Cases (from @scani/core/use-cases):
 * - All use cases are also @Service() decorated and auto-registered
 */
export function initializeContainer(): void {
  // TypeDI auto-registers all classes with @Service() decorator
  // Imports above ensure all our services and repositories are loaded
  // from the core package and backend-specific services

  containerLogger.info(
    {},
    '✅ DI Container initialized with all services and repositories from @scani/core'
  );
}

/**
 * Get the global DI container instance
 */
export function getContainer(): typeof Container {
  return Container;
}

/**
 * Reset the container (useful for testing)
 */
export function resetContainer(): void {
  Container.reset();
  containerLogger.debug({}, 'Container has been reset');
}

export { Container };

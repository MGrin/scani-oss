import 'reflect-metadata';
import { Container } from 'typedi';
import { createComponentLogger } from '../utils/logger';

// Import all repositories to ensure they're registered
import '../infrastructure/repositories/UserRepository';
import '../infrastructure/repositories/TokenRepository';
import '../infrastructure/repositories/TokenPriceRepository';
import '../infrastructure/repositories/InstitutionRepository';
import '../infrastructure/repositories/AccountRepository';
import '../infrastructure/repositories/HoldingRepository';
import '../infrastructure/repositories/EnumRepositories';
import '../infrastructure/repositories/BaseRepository';

// Import all services to ensure they're registered
import '../application/services/UserService';
import '../application/services/TokenService';
import '../application/services/TokenPriceService';
import '../application/services/InstitutionService';
import '../application/services/AccountService';
import '../application/services/HoldingService';
import '../application/services/PricingService';
import '../application/services/PortfolioValuationService';
import '../application/services/TokenValidationService';
import '../application/services/BatchOperationsService';
import '../application/services/EnumServices';
import '../application/services/BaseService';

const containerLogger = createComponentLogger('container');

/**
 * Initialize the Dependency Injection Container
 * This must be called before any service instantiation
 */
export function initializeContainer(): void {
  containerLogger.info({}, 'Initializing Dependency Injection Container');

  // TypeDI auto-registers all classes with @Service() decorator
  // Imports above ensure all our services and repositories are loaded

  containerLogger.info({}, '✓ DI Container initialized with all services and repositories');
  containerLogger.debug(
    {},
    'Registered services: User, Token, TokenPrice, Institution, Account, Holding, Pricing, PortfolioValuation, TokenValidation, Enums'
  );
  containerLogger.debug(
    {},
    'Registered repositories: User, Token, TokenPrice, Institution, Account, Holding, Enums'
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

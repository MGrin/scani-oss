import 'reflect-metadata';
import { createComponentLogger } from '@scani/logging';
import { Container } from 'typedi';

// Import all repositories to ensure they're registered with TypeDI
// This loads all @Service() decorated classes from the core package
import '@scani/domain/repositories';

// Import all services to ensure they're registered with TypeDI
// This loads all @Service() decorated classes from the core package
import '@scani/domain/services';

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
 * Registered Services and Repositories are auto-loaded via the
 * `@scani/domain/services` and `@scani/domain/repositories` barrels;
 * see those packages for the up-to-date list.
 *
 * Registered Use Cases (from @scani/domain/use-cases):
 * - All use cases are also @Service() decorated and auto-registered
 */
export function initializeContainer(): void {
  // TypeDI auto-registers all classes with @Service() decorator
  // Imports above ensure all our services and repositories are loaded
  // from the core package and backend-specific services

  containerLogger.info(
    {},
    '✅ DI Container initialized with all services and repositories from @scani/domain'
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

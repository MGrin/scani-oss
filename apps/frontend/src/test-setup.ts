// Test setup for Bun tests
// Set up DOM environment for React Testing Library
import { GlobalRegistrator } from '@happy-dom/global-registrator';

// Register DOM globals (document, window, etc.)
GlobalRegistrator.register();

// Import jest-dom for DOM assertions (runtime only, no TypeScript types)
import '@testing-library/jest-dom';

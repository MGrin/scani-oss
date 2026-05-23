// `@scani/providers-google-sheets` barrel.
//
// Backend / worker boot imports `GoogleSheetsProvider` and the
// `googleSheetsFactory` from here, registers it onto
// `ProviderRegistry`, and PricingService picks it up by `providerKey`.
//
// Kept as a sibling sub-workspace of `@scani/providers` so the
// `googleapis` SDK doesn't get pulled into every consumer of the main
// providers package.

export type { GoogleSheetsFactoryDeps } from './factory';
export { googleSheetsFactory } from './factory';
export {
  type ConvertPriceFn,
  type CreateFailureResultFn,
  GoogleSheetsProvider,
  type PricingExecutionContext,
  type PricingResult,
  type RoutedToken,
} from './google-sheets-provider';

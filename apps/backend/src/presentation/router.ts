import { Container } from "typedi";
import { AccountService } from "../application/services/AccountService";
import { InstitutionService } from "../application/services/InstitutionService";
import { PricingService } from "../application/services/PricingService";
import { ScreenshotParsingService } from "../application/services/ScreenshotParsingService";
import { TokenValidationService } from "../application/services/TokenValidationService";
import { TransactionService } from "../application/services/TransactionService";
import { WalletService } from "../application/services/WalletService";
import { db } from "../infrastructure/database/connection";
import * as schema from "../infrastructure/database/schema";
import { AccountRepository } from "../infrastructure/repositories/AccountRepository";
import { TokenTypeRepository } from "../infrastructure/repositories/EnumRepositories";
import { HoldingRepository } from "../infrastructure/repositories/HoldingRepository";
import { InstitutionRepository } from "../infrastructure/repositories/InstitutionRepository";
import { TokenPriceRepository } from "../infrastructure/repositories/TokenPriceRepository";
import { TokenRepository } from "../infrastructure/repositories/TokenRepository";
import { TransactionRepository } from "../infrastructure/repositories/TransactionRepository";
import { UserRepository } from "../infrastructure/repositories/UserRepository";
import { accountTypesRouter } from "./routers/account-types";
import { createAccountsRouter } from "./routers/accounts";
import { createBatchOperationsRouter } from "./routers/batch-operations";
import { dashboardRouter } from "./routers/dashboard";
import { createHoldingsRouter } from "./routers/holdings";
import { institutionTypesRouter } from "./routers/institution-types";
import { createInstitutionsRouter } from "./routers/institutions";
import { createScreenshotParsingRouter } from "./routers/screenshot-parsing";
import { tokenTypesRouter } from "./routers/token-types";
import { createTokenPricesRouter } from "./routers/tokenPrices";
import { createTokensRouter } from "./routers/tokens";
import { transactionTypesRouter } from "./routers/transaction-types";
import { createTransactionsRouter } from "./routers/transactions";
import { usersRouter } from "./routers/users";
import { createWalletRouter } from "./routers/wallet";
import { publicProcedure, router } from "./trpc";

// Create routers with DI
const tokensRouter = createTokensRouter(
  db,
  schema,
  Container.get(TokenRepository),
  Container.get(TokenTypeRepository),
  Container.get(TokenPriceRepository),
  Container.get(UserRepository),
  Container.get(AccountRepository),
  Container.get(HoldingRepository),
  Container.get(PricingService),
  Container.get(TokenValidationService)
);

const tokenPricesRouter = createTokenPricesRouter(
  Container.get(TokenPriceRepository)
);

const institutionsRouter = createInstitutionsRouter(
  Container.get(InstitutionRepository),
  Container.get(InstitutionService)
);

const accountsRouter = createAccountsRouter(
  Container.get(AccountRepository),
  Container.get(AccountService)
);

const holdingsRouter = createHoldingsRouter(Container.get(HoldingRepository));

const transactionsRouter = createTransactionsRouter(
  Container.get(TransactionRepository),
  Container.get(TransactionService)
);

const walletRouter = createWalletRouter(Container.get(WalletService));

const screenshotParsingRouter = createScreenshotParsingRouter(
  Container.get(ScreenshotParsingService)
);

const batchOperationsRouter = createBatchOperationsRouter();

export const appRouter = router({
  // User management (protected)
  users: usersRouter,

  // Dashboard (protected) - Aggregated data for overview
  dashboard: dashboardRouter,

  // Core financial entities (protected)
  tokens: tokensRouter,
  tokenPrices: tokenPricesRouter,

  // Enum tables (protected)
  institutionTypes: institutionTypesRouter,
  accountTypes: accountTypesRouter,
  transactionTypes: transactionTypesRouter,
  tokenTypes: tokenTypesRouter,

  // Business entities (protected)
  institutions: institutionsRouter,
  accounts: accountsRouter,
  holdings: holdingsRouter,
  transactions: transactionsRouter,

  // Batch operations (protected) - Atomic multi-entity operations
  batchOperations: batchOperationsRouter,

  // Wallet & blockchain features (protected)
  wallet: walletRouter,

  // AI-powered features (protected)
  screenshotParsing: screenshotParsingRouter,

  // Health check (public)
  health: router({
    check: publicProcedure.query(() => ({
      status: "ok",
      timestamp: new Date(),
    })),
  }),
});

export type AppRouter = typeof appRouter;

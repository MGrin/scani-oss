/**
 * Repository Interfaces
 *
 * These interfaces define the contract for all repository implementations.
 * They enable dependency inversion and make the code testable.
 */

import type {
  Account,
  AccountType,
  Holding,
  Institution,
  InstitutionType,
  NewAccount,
  NewHolding,
  NewInstitution,
  NewToken,
  NewTokenPrice,
  NewUser,
  Token,
  TokenPrice,
  TokenType,
  User,
} from '../../entities';
import type { DatabaseTransaction, IBaseRepository } from './IBaseRepository';

export * from './IBaseRepository';

// ============================================================================
// User Repository Interface
// ============================================================================

export interface IUserRepository extends IBaseRepository<User, NewUser> {
  findByEmail(email: string, transaction?: DatabaseTransaction): Promise<User | null>;
  findWithBaseCurrency(
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<(User & { baseCurrency: Token | null }) | null>;
}

// ============================================================================
// Token Repository Interface
// ============================================================================

export interface ITokenRepository extends IBaseRepository<Token, NewToken> {
  findBySymbol(symbol: string, transaction?: DatabaseTransaction): Promise<Token | null>;
  findBySymbolAndType(
    symbol: string,
    typeId: string,
    transaction?: DatabaseTransaction
  ): Promise<Token | null>;
  findByType(typeCode: string, transaction?: DatabaseTransaction): Promise<Token[]>;
  findByCoinGeckoId(coinGeckoId: string, transaction?: DatabaseTransaction): Promise<Token | null>;
  findBySymbols(symbols: string[], transaction?: DatabaseTransaction): Promise<Token[]>;
  findWithType(
    tokenId: string,
    transaction?: DatabaseTransaction
  ): Promise<(Token & { typeCode: string | null }) | null>;
  searchTokens(query: string, limit: number, transaction?: DatabaseTransaction): Promise<Token[]>;
}

// ============================================================================
// TokenPrice Repository Interface
// ============================================================================

export interface ITokenPriceRepository extends IBaseRepository<TokenPrice, NewTokenPrice> {
  findLatestPrice(
    tokenId: string,
    baseTokenId: string,
    transaction?: DatabaseTransaction
  ): Promise<TokenPrice | null>;

  findPriceHistory(
    tokenId: string,
    baseTokenId: string,
    startDate: Date,
    endDate: Date,
    transaction?: DatabaseTransaction
  ): Promise<TokenPrice[]>;

  findLatestPricesForTokens(
    tokenIds: string[],
    baseTokenId: string,
    transaction?: DatabaseTransaction
  ): Promise<Map<string, TokenPrice>>;

  bulkUpsert(prices: NewTokenPrice[], transaction?: DatabaseTransaction): Promise<TokenPrice[]>;

  findPriceAtTimestamp(
    tokenId: string,
    baseTokenId: string,
    timestamp: Date,
    windowMs: number,
    transaction?: DatabaseTransaction
  ): Promise<TokenPrice | null>;
}

// ============================================================================
// Institution Repository Interface
// ============================================================================

export interface IInstitutionRepository extends IBaseRepository<Institution, NewInstitution> {
  findByName(name: string, transaction?: DatabaseTransaction): Promise<Institution | null>;
  findByUserId(userId: string, transaction?: DatabaseTransaction): Promise<Institution[]>;
  findWithType(
    institutionId: string,
    transaction?: DatabaseTransaction
  ): Promise<(Institution & { typeCode: string | null }) | null>;
  findWithAccounts(
    institutionId: string,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<(Institution & { accounts: Account[] }) | null>;
}

// ============================================================================
// Account Repository Interface
// ============================================================================

export interface IAccountRepository extends IBaseRepository<Account, NewAccount> {
  findByUser(userId: string, transaction?: DatabaseTransaction): Promise<Account[]>;
  findByInstitution(
    institutionId: string,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<Account[]>;
  findWithHoldings(
    accountId: string,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<(Account & { holdings: Holding[] }) | null>;
  findByNameAndInstitution(
    name: string,
    institutionId: string,
    userId: string,
    excludeId?: string,
    transaction?: DatabaseTransaction
  ): Promise<Account | null>;
  findWithDetails(
    accountId: string,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<(Account & { institutionName: string; typeName: string }) | null>;
}

// ============================================================================
// Holding Repository Interface
// ============================================================================

export interface IHoldingRepository extends IBaseRepository<Holding, NewHolding> {
  findByUser(userId: string, transaction?: DatabaseTransaction): Promise<Holding[]>;
  findByAccount(
    accountId: string,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<Holding[]>;
  findByToken(
    tokenId: string,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<Holding[]>;
  findByAccountAndToken(
    accountId: string,
    tokenId: string,
    userId: string,
    excludeId?: string,
    transaction?: DatabaseTransaction
  ): Promise<Holding | null>;
  findWithDetails(
    holdingId: string,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<
    | (Holding & {
        tokenSymbol: string;
        tokenName: string;
        accountName: string;
      })
    | null
  >;
  findWithToken(
    holdingId: string,
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<(Holding & { token: Token }) | null>;
  findUserHoldingsWithTokens(
    userId: string,
    transaction?: DatabaseTransaction
  ): Promise<Array<Holding & { token: Token }>>;
}

// ============================================================================
// Enum Repository Interfaces
// ============================================================================

export interface IInstitutionTypeRepository
  extends IBaseRepository<InstitutionType, Partial<InstitutionType>> {
  findByCode(code: string, transaction?: DatabaseTransaction): Promise<InstitutionType | null>;
  findActive(transaction?: DatabaseTransaction): Promise<InstitutionType[]>;
}

export interface IAccountTypeRepository extends IBaseRepository<AccountType, Partial<AccountType>> {
  findByCode(code: string, transaction?: DatabaseTransaction): Promise<AccountType | null>;
  findActive(transaction?: DatabaseTransaction): Promise<AccountType[]>;
}

export interface ITokenTypeRepository extends IBaseRepository<TokenType, Partial<TokenType>> {
  findByCode(code: string, transaction?: DatabaseTransaction): Promise<TokenType | null>;
  findActive(transaction?: DatabaseTransaction): Promise<TokenType[]>;
  findByIds(ids: string[], transaction?: DatabaseTransaction): Promise<TokenType[]>;
}

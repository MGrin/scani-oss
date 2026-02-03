# Step 1: Database Layer Analysis

## Overview

This document analyzes the database structure of the Scani Finance SaaS application, focusing on entities, primary keys, foreign keys, indexes, and relationships.

---

## 1. Entity Inventory

### Core Entities (15 tables)

| Table | Purpose | PK Type |
|-------|---------|---------|
| `users` | User accounts | UUID |
| `institutions` | Financial institutions (banks, exchanges, blockchains) | UUID |
| `accounts` | User accounts at institutions | UUID |
| `holdings` | Token balances in accounts | UUID |
| `tokens` | Tradeable assets (fiat, crypto) | UUID |
| `token_prices` | Historical price data | UUID |
| `user_portfolio_events` | Pre-computed portfolio history events | UUID |
| `user_wallets` | User blockchain wallet mappings | UUID |
| `user_integration_credentials` | Encrypted API keys/OAuth tokens | UUID |
| `institution_blockchain_mappings` | Institution to blockchain chain mappings | UUID |
| `groups` | User-defined custom groups | UUID |
| `holding_groups` | Many-to-many: holdings ↔ groups | UUID |
| `account_groups` | Many-to-many: accounts ↔ groups | UUID |
| `api_keys` | MCP server API keys | UUID |

### Enum/Lookup Tables (3 tables)

| Table | Purpose | PK Type |
|-------|---------|---------|
| `institution_types` | Bank, Broker, Exchange, Blockchain | UUID |
| `account_types` | Checking, Savings, Wallet, etc. | UUID |
| `token_types` | Fiat, Crypto | UUID |

---

## 2. Relationship Analysis

### Entity Relationship Diagram (Conceptual)

```
                                   ┌─────────────────┐
                                   │ institution_types│
                                   └────────┬────────┘
                                            │ 1:N
                    ┌───────────────────────┼───────────────────────┐
                    │                       │                       │
                    ▼                       ▼                       │
            ┌───────────────┐     ┌─────────────────────────┐       │
            │  institutions │────▶│ institution_blockchain_ │       │
            │               │ 1:1 │      mappings           │       │
            └───────┬───────┘     └─────────────────────────┘       │
                    │ 1:N                                           │
                    ▼                                               │
            ┌───────────────┐     ┌────────────────┐                │
   ┌───────▶│   accounts    │◀────│  account_types │◀───────────────┘
   │        └───────┬───────┘ N:1 └────────────────┘
   │                │ 1:N
   │                ▼
   │        ┌───────────────┐     ┌────────────────┐
   │        │   holdings    │────▶│    tokens      │◀───┐
   │        └───────┬───────┘ N:1 └────────┬───────┘    │
   │                │                      │ 1:N        │
   │                │              ┌───────▼───────┐    │
   │                │              │  token_prices │────┘
   │                │              │  (base_token) │
   │                │              └───────────────┘
   │                │
   │   ┌────────────┼────────────────────────────────────┐
   │   │            │                                    │
   │   │   ┌────────▼────────┐     ┌──────────────────┐  │
   │   │   │ user_portfolio_ │     │  holding_groups  │  │
   │   │   │     events      │     └────────┬─────────┘  │
   │   │   └─────────────────┘              │            │
   │   │                                    │            │
   │   │                            ┌───────▼───────┐    │
   │   │                            │    groups     │◀───┤
   │   │                            └───────┬───────┘    │
   │   │                                    │            │
   │   │                            ┌───────▼───────┐    │
   │   │                            │ account_groups │───┘
   │   │                            └───────────────┘
   │   │
   │   │
┌──▼───▼──────────────────────────────────────────────────────────┐
│                           users                                  │
│  ├── user_wallets                                                │
│  ├── user_integration_credentials                                │
│  ├── api_keys                                                    │
│  └── base_currency (→ tokens)                                    │
└─────────────────────────────────────────────────────────────────┘
                                │
                        ┌───────▼───────┐
                        │  token_types  │
                        └───────────────┘
```

### Foreign Key Summary

| Parent Table | Child Table | Relationship | On Delete |
|-------------|-------------|--------------|-----------|
| users | accounts | 1:N | CASCADE |
| users | holdings | 1:N | CASCADE |
| users | user_wallets | 1:N | CASCADE |
| users | user_integration_credentials | 1:N | CASCADE |
| users | groups | 1:N | CASCADE |
| users | api_keys | 1:N | CASCADE |
| users | user_portfolio_events | 1:N | CASCADE |
| tokens | users.baseCurrencyId | N:1 | RESTRICT |
| institutions | accounts | 1:N | CASCADE |
| institution_types | institutions | 1:N | RESTRICT |
| accounts | holdings | 1:N | CASCADE |
| account_types | accounts | 1:N | RESTRICT |
| tokens | holdings | 1:N | RESTRICT |
| token_types | tokens | 1:N | RESTRICT |
| tokens | token_prices.tokenId | 1:N | CASCADE |
| tokens | token_prices.baseTokenId | 1:N | RESTRICT |
| holdings | holding_groups | 1:N | CASCADE |
| groups | holding_groups | 1:N | CASCADE |
| accounts | account_groups | 1:N | CASCADE |
| groups | account_groups | 1:N | CASCADE |
| institutions | user_integration_credentials | 1:N | CASCADE |
| institutions | institution_blockchain_mappings | 1:1 | CASCADE |

---

## 3. Index Analysis

### ✅ Well-Indexed Tables

| Table | Indexes | Assessment |
|-------|---------|------------|
| `holdings` | 7 indexes (user, account, token, composites, hidden, active) | **Excellent** - covers all query patterns |
| `token_prices` | 3 indexes (lookup composite, timestamp desc) | **Good** - optimized for price lookups |
| `user_portfolio_events` | 6 indexes (user+time, holding, account, institution, type, token) | **Excellent** - covers all filtering scenarios |
| `accounts` | 4 indexes (user, institution, composite) | **Good** |
| `institutions` | 2 indexes (name, website unique) | **Adequate** |
| `tokens` | 3 indexes (symbol, type, symbol+type unique) | **Good** |
| `groups` | 3 indexes (user, display_order composite) | **Good** |

### ⚠️ Potential Index Improvements

1. **`user_wallets`**: Has index on `wallet_address` but queries often filter by `user_id + wallet_address` - could benefit from composite
2. **`user_integration_credentials`**: Has composite index but no index on `credentials_type` alone
3. **`api_keys`**: Missing index on `key_hash` for authentication lookups

---

## 4. Data Modeling Observations

### ✅ Good Patterns

1. **UUID Primary Keys**: Consistent use of UUID for all entities - good for distributed systems
2. **Soft Delete Support**: `isActive` and `isHidden` flags allow soft deletes
3. **Audit Timestamps**: `createdAt` and `updatedAt` on all tables
4. **Decimal Precision**: Financial values stored as `text` for Decimal.js precision
5. **Dynamic Enums**: Types stored in database tables, not TypeScript enums
6. **Denormalization for Performance**: `user_portfolio_events` stores denormalized token info
7. **Proper Cascade Deletes**: User deletion cascades to all user-owned data

### ⚠️ Concerns

1. **`userId` on Holdings** ✅ Intentional
   - `holdings` has `userId` but also `accountId`
   - Account already has `userId` - this is denormalization for query performance
   - **Status**: Intentional design for query performance and data verification

2. **No Unique Constraint on Holdings** ✅ Intentional
   - Same token CAN exist multiple times in same account
   - **Status**: Expected behavior - supports multiple positions of same token

3. **Inconsistent `lastUpdated` vs `updatedAt`** ⚠️ Valid Concern
   - `holdings` has `lastUpdated` instead of `updatedAt`
   - Inconsistent with other tables
   - **Impact**: Minor confusion, but functional
   - **Recommendation**: Consider renaming for consistency

4. **Missing Index on `api_keys.key_hash`** ⚠️ Valid Concern
   - Authentication lookups query by key hash
   - **Recommendation**: Add index for performance

5. **JSON/JSONB Fields** ✅ Expected
   - `accounts.metadata`, `user_integration_credentials.encrypted_credentials`
   - Not schema-validated at database level
   - **Status**: Expected pattern for flexible metadata storage

---

## 5. Missing Entity Considerations

Based on domain analysis, consider these potential future entities:

| Entity | Purpose | Priority |
|--------|---------|----------|
| `transactions` | Track buys, sells, transfers | High |
| `transaction_types` | Buy, Sell, Transfer, Dividend, etc. | High |
| `scheduled_syncs` | Track cron job executions | Medium |
| `audit_logs` | Track all data changes | Medium |
| `notifications` | User alerts and notifications | Low |

---

## 6. Schema Health Score

| Aspect | Score | Notes |
|--------|-------|-------|
| **Normalization** | 8/10 | Some intentional denormalization for performance |
| **Index Coverage** | 9/10 | Excellent index coverage for query patterns |
| **Referential Integrity** | 9/10 | Good FK coverage with appropriate cascade rules |
| **Data Type Consistency** | 8/10 | Good, but `lastUpdated` vs `updatedAt` inconsistency |
| **Naming Conventions** | 9/10 | Consistent snake_case, clear names |
| **Audit Support** | 7/10 | Timestamps present, but no change tracking |

**Overall Score: 8.3/10**

---

## 7. Recommendations Summary

### High Priority
1. Add unique constraint on `holdings(accountId, tokenId)` if duplicate prevention is desired
2. Add index on `api_keys.key_hash` for authentication performance
3. Standardize `lastUpdated` to `updatedAt` on holdings table

### Medium Priority
4. Add `transactions` and `transaction_types` tables for financial tracking
5. Consider adding `scheduled_syncs` for cron job auditing
6. Add composite index on `user_wallets(userId, walletAddress)`

### Low Priority
7. Add JSON schema validation triggers for JSONB fields
8. Consider adding `audit_logs` table for compliance
9. Document the intentional `userId` denormalization on holdings

---

## Next Step

Proceed to **Step 2: Repository Layer Analysis** to examine how these entities are accessed and whether repository abstractions properly encapsulate database operations.

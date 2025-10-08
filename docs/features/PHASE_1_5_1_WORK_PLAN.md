# 📋 Phase 1.5.1 Work Plan - Crypto Wallet Integration

**Created:** October 2, 2025  
**Status:** 🚧 **IN PROGRESS** (NOT COMPLETE!)  
**Estimated Duration:** 3-5 days (remaining: 3-4 days)

---

## ⚠️ Reality Check

### What We ACTUALLY Have ✅

1. **Native Balance Fetching** (50 blockchains)

   - ✅ 35 EVM chains (Ethereum, Polygon, BSC, etc.)
   - ✅ 5 fully implemented non-EVM chains (Bitcoin, Tron, Solana, Algorand, Aptos)
   - ✅ 2 partial implementations (Bitcoin Cash, Cardano, Litecoin)
   - ✅ 7 stub implementations (Cosmos, Hedera, Near, Polkadot, Ripple, Stellar, Sui)

2. **Backend Infrastructure**

   - ✅ Chain service architecture
   - ✅ Multi-chain router
   - ✅ Address detection logic (16 types)
   - ✅ Rate limiting per chain
   - ✅ 156 unit tests passing
   - ✅ tRPC endpoints (`wallet.detectAddress`, `wallet.import`, `wallet.sync`)

3. **Database Schema**
   - ✅ Wallet metadata in `accounts.metadata` JSONB
   - ✅ Holdings table ready for token storage

### What We DON'T Have ❌

#### 1. Token Support (CRITICAL!) 🔴

**Missing:**

- ❌ **ERC-20 tokens** (Ethereum ecosystem)
- ❌ **TRC-20 tokens** (Tron ecosystem)
- ❌ **SPL tokens** (Solana ecosystem)
- ❌ **BEP-20 tokens** (BSC ecosystem)
- ❌ **Custom tokens** on other EVM chains
- ❌ **Token detection** (automatic discovery)
- ❌ **Multi-token balance fetching**
- ❌ **Token metadata** (name, symbol, decimals)

**Impact:** Users can only see native balances (ETH, BTC, SOL), not actual tokens (USDT, USDC, etc.)

#### 2. Stub Chain Implementations 🟡

**7 chains return zero balance:**

- ❌ Cosmos (ATOM) - needs API integration
- ❌ Hedera (HBAR) - needs API integration
- ❌ Near Protocol (NEAR) - needs API integration
- ❌ Polkadot (DOT) - needs API integration
- ❌ Ripple (XRP) - needs API integration
- ❌ Stellar (XLM) - needs API integration
- ❌ Sui (SUI) - needs API integration

**Impact:** 7/50 chains don't actually work

#### 3. Name Service Resolution 🟡

**Missing:**

- ❌ **ENS resolution** (.eth names → 0x addresses)
- ❌ **Solana Name Service** (.sol names → Solana addresses)
- ❌ **Unstoppable Domains** (.crypto, .nft, etc.)
- ❌ **Other name services** (Lens, Avvy, etc.)

**Impact:** Users can't use human-readable names

#### 4. Frontend UI (CRITICAL!) 🔴

**Current State:**

- ✅ Wallet icon in navigation
- ✅ "Crypto Wallet" button in AddData page
- ❌ **NO wallet import flow UI**
- ❌ **NO address input form**
- ❌ **NO chain selection UI**
- ❌ **NO balance display**
- ❌ **NO sync button**
- ❌ **NO wallet management page**

**Impact:** Feature is completely unusable by end users

---

## 🎯 Work Plan: Remaining Tasks

### Phase 1.5.1a: Core Token Support (2-3 days) 🔴 CRITICAL

**Priority 1: ERC-20 Token Support**

- [ ] Implement `getTokenBalance()` for EVM chains
- [ ] Token contract ABI (ERC-20 standard)
- [ ] Multi-token balance fetching
- [ ] Automatic token discovery (detect popular tokens)
- [ ] Token metadata fetching (name, symbol, decimals)
- [ ] CoinGecko integration for token prices
- [ ] Rate limiting for token API calls
- [ ] Update tRPC endpoints to support tokens
- [ ] Database schema for token holdings

**Priority 2: Multi-Chain Token Support**

- [ ] TRC-20 tokens on Tron
- [ ] SPL tokens on Solana
- [ ] BEP-20 tokens on BSC
- [ ] Token standards for other EVM chains

**Estimated Time:** 2-3 days

### Phase 1.5.1b: Frontend UI (1-2 days) 🔴 CRITICAL

**Components to Build:**

- [ ] `WalletImportDialog.tsx` - Main wallet import modal
- [ ] `WalletAddressInput.tsx` - Address input with validation
- [ ] `ChainSelector.tsx` - Multi-select chain picker
- [ ] `WalletBalanceDisplay.tsx` - Show detected balances
- [ ] `WalletSyncButton.tsx` - Manual sync trigger
- [ ] `WalletManagementCard.tsx` - Manage imported wallets
- [ ] `WalletListPage.tsx` - View all wallets (optional)

**User Flow:**

1. Click "Import Crypto Wallet" button
2. Enter wallet address
3. Auto-detect address type and supported chains
4. Show preview of balances
5. Confirm import
6. Create account + holdings in database
7. Show success message with portfolio update

**Estimated Time:** 1-2 days

### Phase 1.5.1c: Name Service Resolution (1 day) 🟡 NICE-TO-HAVE

**Implementation:**

- [ ] ENS resolution service (.eth → 0x)
- [ ] Solana Name Service (.sol → Solana)
- [ ] Unstoppable Domains support
- [ ] Frontend: Auto-resolve names on input
- [ ] Backend: Cache resolved addresses
- [ ] Rate limiting for name resolution

**Estimated Time:** 1 day (can be done in parallel or after beta)

### Phase 1.5.1d: Stub Chain Implementation (1-2 days) 🟡 NICE-TO-HAVE

**Options:**

1. **Option A:** Implement full API integration for all 7 chains (2-3 days)
2. **Option B:** Implement 2-3 most popular chains (Ripple, Stellar, Polkadot) (1 day)
3. **Option C:** Keep stubs, add warning in UI, defer to post-beta (0 days)

**Recommendation:** Option C - Focus on token support and UI first

**Estimated Time:** 0 days (defer to post-beta)

---

## 📅 Revised Timeline

### Current Status (October 2, 2025)

**Day 1-2 (Oct 1-2):** ✅ Native balance infrastructure

- Chain services for 50 blockchains
- Multi-chain router
- Address detection
- Backend tRPC endpoints
- 156 unit tests

**Day 3-5 (Oct 3-5):** 🚧 Token support + UI

- Day 3: ERC-20 token implementation
- Day 4: Multi-chain token support (TRC-20, SPL)
- Day 5: Frontend UI components

**Day 6 (Oct 6):** 🚧 Integration + Testing

- End-to-end testing
- Bug fixes
- Documentation updates

**Day 7 (Oct 7):** ✅ Phase 1.5.1 Complete

- Full token support (ERC-20, TRC-20, SPL)
- Working frontend UI
- Production-ready feature

---

## 🎯 Definition of Done

Phase 1.5.1 will be **ACTUALLY COMPLETE** when:

### Backend ✅

- [x] Native balance fetching for 50 chains
- [ ] ERC-20 token balance fetching
- [ ] TRC-20 token balance fetching
- [ ] SPL token balance fetching
- [ ] Token metadata fetching
- [ ] Multi-token import in single transaction
- [ ] Rate limiting for all token APIs
- [ ] Comprehensive error handling

### Frontend ❌

- [ ] Wallet import dialog UI
- [ ] Address input with auto-detection
- [ ] Chain selection UI
- [ ] Balance preview before import
- [ ] Success/error messages
- [ ] Wallet management UI
- [ ] Manual sync functionality

### Testing 🟡

- [x] Unit tests for chain services
- [ ] Unit tests for token services
- [ ] Integration tests for wallet import
- [ ] E2E test for full user flow

### Documentation 🟡

- [x] Technical architecture documented
- [ ] User guide for wallet import
- [ ] API documentation for token endpoints
- [ ] Known limitations documented

---

## 🚫 What We're NOT Doing in Phase 1.5.1

**Out of Scope (Post-Beta):**

- ❌ Transaction history fetching
- ❌ Multi-wallet portfolio aggregation
- ❌ DeFi protocol integration (staking, lending, etc.)
- ❌ NFT support
- ❌ Cross-chain analytics
- ❌ Automatic sync in background (cron jobs)
- ❌ Real-time balance updates via WebSocket
- ❌ Historical balance tracking

**Deferred (Optional):**

- 🔶 Name service resolution (ENS, .sol) - Nice to have, not critical
- 🔶 Full implementation of 7 stub chains - Can be done post-beta
- 🔶 Token discovery (scan for all tokens) - Start with popular tokens only
- 🔶 Custom token addition by contract address - Use CoinGecko list first

---

## 💡 Key Insights

### Why This Matters

1. **Token support is CRITICAL** - 95% of crypto portfolio value is in tokens, not native assets
2. **UI is CRITICAL** - Backend without UI = unusable feature
3. **ENS is nice-to-have** - Most users will paste addresses
4. **Stub chains are acceptable** - Better to have 43 working chains than 50 partially broken ones

### Risk Mitigation

- Focus on ERC-20 first (largest ecosystem)
- Use CoinGecko for token metadata (already integrated)
- Simple UI first, polish later
- Defer name services to post-beta if needed

### Success Metrics

- ✅ Users can import wallets with 1 click
- ✅ Popular tokens automatically detected (USDT, USDC, LINK, UNI, etc.)
- ✅ Balances update on manual sync
- ✅ Zero errors on import for 43+ chains
- ✅ Complete in 5-7 days total

---

## 📌 Next Steps

**Immediate Actions (October 3, 2025):**

1. **Start with ERC-20 implementation** (highest impact)

   - Research ERC-20 ABI and balance fetching
   - Implement `getTokenBalance()` in EVM service
   - Add token detection logic
   - Test with major tokens (USDT, USDC, LINK)

2. **Design Frontend UI** (can be done in parallel)

   - Create component mockups
   - Plan user flow
   - Design state management
   - Create validation schemas

3. **Update Documentation**
   - Mark completion report as "DRAFT"
   - Update roadmap with realistic timeline
   - Document what's actually done vs. pending

---

**Last Updated:** October 2, 2025  
**Next Review:** October 3, 2025 (after ERC-20 implementation)

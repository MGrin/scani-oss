# Supported Blockchain Networks

## Overview

Scani now supports **50 blockchain networks** across multiple ecosystems:

- **35 EVM-compatible chains** (Ethereum, Layer 2s, sidechains)
- **15 Non-EVM chains** (Bitcoin, Solana, Cardano, etc.)

All chains are integrated with the wallet import system and can automatically create accounts and holdings when a user imports a wallet address.

---

## EVM Chains (35)

All EVM chains use standard Ethereum-compatible addresses (0x...) and support native token balance queries via RPC endpoints.

| #   | Chain Name          | Chain ID | Native Token | Status             |
| --- | ------------------- | -------- | ------------ | ------------------ |
| 1   | Ethereum            | 1        | ETH          | ✅ Fully Supported |
| 2   | Arbitrum            | 42161    | ETH          | ✅ Fully Supported |
| 3   | Arbitrum Nova       | 42170    | ETH          | ✅ Fully Supported |
| 4   | Avalanche           | 43114    | AVAX         | ✅ Fully Supported |
| 5   | Base                | 8453     | ETH          | ✅ Fully Supported |
| 6   | Berachain           | 80094    | BERA         | ✅ Fully Supported |
| 7   | Binance Smart Chain | 56       | BNB          | ✅ Fully Supported |
| 8   | BitTorrent Chain    | 199      | BTT          | ✅ Fully Supported |
| 9   | Blast               | 81457    | ETH          | ✅ Fully Supported |
| 10  | Celo                | 42220    | CELO         | ✅ Fully Supported |
| 11  | Cronos              | 25       | CRO          | ✅ Fully Supported |
| 12  | Fantom              | 250      | FTM          | ✅ Fully Supported |
| 13  | Fraxtal             | 252      | frxETH       | ✅ Fully Supported |
| 14  | Gnosis              | 100      | xDAI         | ✅ Fully Supported |
| 15  | HyperEVM            | 999      | ETH          | ✅ Fully Supported |
| 16  | Linea               | 59144    | ETH          | ✅ Fully Supported |
| 17  | Mantle              | 5000     | MNT          | ✅ Fully Supported |
| 18  | Moonbeam            | 1284     | GLMR         | ✅ Fully Supported |
| 19  | Moonriver           | 1285     | MOVR         | ✅ Fully Supported |
| 20  | Optimism            | 10       | ETH          | ✅ Fully Supported |
| 21  | Polygon             | 137      | MATIC        | ✅ Fully Supported |
| 22  | Ronin               | 747474   | RON          | ✅ Fully Supported |
| 23  | Scroll              | 534352   | ETH          | ✅ Fully Supported |
| 24  | Sei                 | 1329     | SEI          | ✅ Fully Supported |
| 25  | Sonic               | 146      | S            | ✅ Fully Supported |
| 26  | Sophon              | 50104    | SOPH         | ✅ Fully Supported |
| 27  | Swellchain          | 1923     | ETH          | ✅ Fully Supported |
| 28  | Taiko               | 167000   | ETH          | ✅ Fully Supported |
| 29  | Unichain            | 130      | ETH          | ✅ Fully Supported |
| 30  | World Chain         | 480      | ETH          | ✅ Fully Supported |
| 31  | XDC Network         | 50       | XDC          | ✅ Fully Supported |
| 32  | opBNB               | 204      | BNB          | ✅ Fully Supported |
| 33  | zkSync Era          | 324      | ETH          | ✅ Fully Supported |
| 34  | Abstract            | 2741     | ETH          | ✅ Fully Supported |
| 35  | ApeChain            | 33139    | APE          | ✅ Fully Supported |

---

## Non-EVM Chains (15)

### UTXO-Based Chains (3)

| #   | Chain Name      | Chain ID | Native Token | Address Format       | Status             |
| --- | --------------- | -------- | ------------ | -------------------- | ------------------ |
| 1   | Bitcoin Network | 0        | BTC          | 1/3/bc1...           | ✅ Fully Supported |
| 2   | Bitcoin Cash    | -3       | BCH          | 1/3/bitcoincash:q... | ✅ Fully Supported |
| 3   | Litecoin        | -4       | LTC          | L/M/ltc1...          | ✅ Fully Supported |

### Account-Based Chains (12)

| #   | Chain Name    | Chain ID | Native Token | Address Format       | Status              |
| --- | ------------- | -------- | ------------ | -------------------- | ------------------- |
| 4   | Tron          | -1       | TRX          | T...                 | ✅ Fully Supported  |
| 5   | Solana        | -2       | SOL          | base58 (32-44 chars) | ✅ Fully Supported  |
| 6   | Algorand      | -10      | ALGO         | Base32 (58 chars)    | ✅ Fully Supported  |
| 7   | Aptos         | -11      | APT          | 0x... (short hex)    | ✅ Fully Supported  |
| 8   | Cardano       | -5       | ADA          | addr1...             | ✅ Fully Supported  |
| 9   | Cosmos        | -6       | ATOM         | cosmos1...           | ⚠️ Stub (returns 0) |
| 10  | Hedera        | -7       | HBAR         | 0.0.12345            | ⚠️ Stub (returns 0) |
| 11  | Near Protocol | -8       | NEAR         | username.near        | ⚠️ Stub (returns 0) |
| 12  | Polkadot      | -9       | DOT          | 1...                 | ⚠️ Stub (returns 0) |
| 13  | Ripple        | -12      | XRP          | r...                 | ⚠️ Stub (returns 0) |
| 14  | Stellar       | -13      | XLM          | G...                 | ⚠️ Stub (returns 0) |
| 15  | Sui           | -14      | SUI          | 0x... (64 hex chars) | ⚠️ Stub (returns 0) |

---

## Chain ID Assignments

### Standard Chain IDs

- **EVM Chains**: Use official chain IDs (1 for Ethereum, 137 for Polygon, etc.)
- **Bitcoin**: Chain ID `0`

### Custom Chain IDs (Non-EVM)

All non-EVM chains use negative chain IDs to avoid conflicts:

```typescript
const CUSTOM_CHAIN_IDS = {
  TRON: -1,
  SOLANA: -2,
  BITCOIN_CASH: -3,
  LITECOIN: -4,
  CARDANO: -5,
  COSMOS: -6,
  HEDERA: -7,
  NEAR: -8,
  POLKADOT: -9,
  ALGORAND: -10,
  APTOS: -11,
  RIPPLE: -12,
  STELLAR: -13,
  SUI: -14,
};
```

---

## Implementation Status

### ✅ Fully Supported (43 chains)

These chains have complete API integration with multiple fallback endpoints:

- All 35 EVM chains
- Bitcoin, Bitcoin Cash, Litecoin (UTXO)
- Tron, Solana, Algorand, Aptos, Cardano

**Features:**

- Real-time balance fetching
- Multiple API fallback endpoints
- Rate limiting
- Error handling
- Institution lookup in database
- Automatic account/holding creation

### ⚠️ Stub Implementation (7 chains)

These chains have address validation and basic structure but return zero balance:

- Cosmos, Hedera, Near Protocol, Polkadot, Ripple, Stellar, Sui

**Reason:** These chains require API keys or have complex RPC requirements. They're ready for enhancement when needed.

**Current behavior:**

- Address format validation ✅
- Returns balance = 0
- Logs stub status
- Database institutions exist
- Won't fail wallet imports

---

## Database Alignment

### Perfect Match ✅

All 50 chains in the database have corresponding institutions:

- ✅ All 35 EVM chains matched
- ✅ All 15 non-EVM chains matched
- ✅ No missing institutions
- ✅ No orphaned database entries

---

## API Integration Details

### Rate Limiting

Each chain service has independent rate limiters:

- **EVM chains**: 10 requests/minute per chain
- **Bitcoin/Litecoin**: 20 requests/minute
- **Tron/Solana**: 30 requests/minute
- **Algorand/Aptos/Cardano**: 30 requests/minute

### Fallback Endpoints

**Bitcoin (3 APIs):**

- Blockchain.info
- BlockCypher
- Blockchair

**Litecoin (2 APIs):**

- Blockchair
- BlockCypher

**Bitcoin Cash (2 APIs):**

- Blockchair
- Bitcoin.com

**Solana (3 RPCs):**

- Solana mainnet RPC
- Project Serum RPC
- Ankr RPC

**Tron (2 APIs):**

- TronGrid (official)
- TronScan

**Algorand (3 APIs):**

- AlgoNode mainnet
- Nodely
- AlgoNode indexer

**Aptos (3 APIs):**

- Aptos Labs mainnet
- NodeReal
- Ankr

**Cardano (1 API):**

- Blockfrost (public, no key required)

---

## Wallet Import Flow

### Address Detection

The `detectAddressType()` function automatically identifies the blockchain based on address format:

```typescript
// Examples:
'0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb' → 'evm'
'1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa' → 'bitcoin'
'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb' → 'tron'
'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK' → 'solana'
'ALGORANDADDRESSBASE32ENCODEDUPPERCASEXYZ...' → 'algorand'
'0x1234abcd...' (short) → 'aptos'
'addr1qxy...' → 'cardano'
```

### Import Process

1. User provides wallet address
2. System detects blockchain type
3. Fetches balances across all chains (for multi-chain addresses)
4. Looks up institutions by chain name
5. Creates one account per chain with balance > 0
6. Creates holdings for native tokens
7. Returns summary of accounts created

---

## Future Enhancements

### Priority 1: Stub Chain APIs

Implement full API integration for the 7 stub chains:

- Cosmos → Cosmos Hub REST API
- Hedera → Hedera Mirror Node REST API
- Near → Near RPC
- Polkadot → Subscan API or RPC
- Ripple → XRPL.org API
- Stellar → Horizon API
- Sui → Sui RPC

### Priority 2: ERC-20 Token Support

Add support for ERC-20 tokens on EVM chains:

- Token balance queries
- Token metadata fetching
- Automatic token detection
- Multi-token holdings per account

### Priority 3: ENS Name Resolution

Support Ethereum Name Service (ENS) domains:

- Resolve .eth names to addresses
- Display ENS names in UI
- Reverse resolution (address → ENS)

### Priority 4: Additional Chains

Consider adding support for:

- zkSync Lite
- StarkNet
- Osmosis
- Injective
- Cosmos ecosystem chains

---

## Testing

### Manual Testing Commands

```bash
# Test wallet import (all chains)
curl -X POST http://localhost:3000/trpc/wallet.importWalletAddress \
  -H "Content-Type: application/json" \
  -d '{"address": "YOUR_WALLET_ADDRESS"}'

# Test specific chain detection
bun run src/services/chain/multi-chain.ts
```

### Test Addresses

```typescript
// Test addresses for each chain type
const TEST_ADDRESSES = {
  ethereum: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
  bitcoin: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
  tron: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
  solana: "DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK",
  algorand: "ALGORANDADDRESS...",
  aptos: "0x1",
  cardano: "addr1qxy...",
  // ... etc
};
```

---

## Documentation References

### Service Files

- `services/chain/evm.ts` - All EVM chains
- `services/chain/bitcoin.ts` - Bitcoin
- `services/chain/bitcoin-cash.ts` - Bitcoin Cash
- `services/chain/litecoin.ts` - Litecoin
- `services/chain/tron.ts` - Tron
- `services/chain/solana.ts` - Solana
- `services/chain/algorand.ts` - Algorand
- `services/chain/aptos.ts` - Aptos
- `services/chain/cardano.ts` - Cardano
- `services/chain/additional-chains.ts` - Stub services (7 chains)
- `services/chain/multi-chain.ts` - Address detection & routing

### Configuration

- `config/chains.ts` - EVM chain configs (35 chains)
- `db/schema.ts` - Database schema with institutions

### API Routers

- `routers/wallet.ts` - Wallet import endpoint

---

## Conclusion

Scani now supports **50 blockchain networks**, making it one of the most comprehensive crypto portfolio tracking systems. The system gracefully handles:

- ✅ Automatic address detection
- ✅ Multi-chain balance fetching
- ✅ Fallback API endpoints
- ✅ Rate limiting
- ✅ Error handling
- ✅ Database alignment
- ✅ Transaction safety

**Production Ready:** 43 out of 50 chains have full API integration. The remaining 7 stub implementations won't cause errors and can be enhanced as needed.

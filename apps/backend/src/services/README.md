# Token Pricing Services

This document describes the token pricing system implemented for automatic price fetching and portfolio valuation.

## Overview

The pricing system consists of three main components:

1. **PricingService** - Core service for fetching token prices from various providers
2. **PortfolioValuationService** - Service for calculating portfolio values
3. **Transaction Integration** - Automatic price fetching during transaction creation

## Error Handling & Missing Prices

The system gracefully handles unavailable prices:

- **Missing prices return "0"** instead of throwing errors
- **Zero prices are never cached** to allow future retries
- **Portfolio calculations include zero-value holdings** in totals
- **All aggregations treat missing prices as 0** for consistent behavior

This ensures the system remains functional even when:

- Tokens are not found in provider databases
- API access is restricted (e.g., free tier limitations)
- Network issues prevent price fetching
- Manual prices haven't been set for private tokens

## Providers Used

### Primary Provider: Finnhub

- **Covers**: Stocks, ETFs, Bonds, Commodities, Mutual Funds
- **Cost**: Free tier with 60 calls/minute, paid plans available
- **Strengths**: Comprehensive coverage, real-time data, excellent API documentation
- **Limitations**: Free tier may not include all markets; paid plans provide broader coverage
- **API Key Required**: `FINNHUB_API_KEY`

### Crypto Backup: CoinGecko

- **Covers**: 10,000+ cryptocurrencies
- **Cost**: Free tier with 30 calls/minute
- **Strengths**: Best crypto coverage, generous free tier
- **API Key**: Optional (`COINGECKO_API_KEY`)

### Fiat Backup: ExchangeRate-API

- **Covers**: All major fiat currencies
- **Cost**: Free (1500 requests/month)
- **Strengths**: No API key required, good coverage
- **API Key**: None required

## Setup

### Environment Variables

```bash
# Required for stocks/ETFs/bonds/commodities
FINNHUB_API_KEY=your_finnhub_key

# Optional for enhanced crypto features
COINGECKO_API_KEY=your_coingecko_key
```

### Database Schema

The system uses the existing `tokenPrices` table with the following structure:

```sql
token_prices (
  id UUID PRIMARY KEY,
  token_id UUID REFERENCES tokens(id),
  base_token_id UUID REFERENCES tokens(id),
  price REAL NOT NULL,
  timestamp TIMESTAMP NOT NULL,
  source TEXT,
  created_at TIMESTAMP DEFAULT NOW()
)
```

## Usage

### 1. Basic Price Fetching

```typescript
import { PricingService } from "../services/pricing";

const pricingService = new PricingService();

// Get current price - always fetches if not cached
const price = await pricingService.getTokenPrice({
  tokenSymbol: "AAPL",
  baseCurrency: "USD",
  timestamp: new Date(),
  live: true, // Indicates preference for fresh data, but will fetch regardless
});

// Get historical price
const historicalPrice = await pricingService.getTokenPrice({
  tokenSymbol: "AAPL",
  baseCurrency: "USD",
  timestamp: new Date("2024-01-01"),
  live: false,
});
```

### 2. Portfolio Valuation

```typescript
import { PortfolioValuationService } from "../services/portfolio-valuation";

const portfolioService = new PortfolioValuationService();

// Get user's current portfolio value
const portfolio = await portfolioService.getUserPortfolioValue(userId);
console.log(`Total value: ${portfolio.totalValue} ${portfolio.baseCurrency}`);

// Update all portfolio prices (scheduled job)
await portfolioService.updateAllPortfolioPrices();
```

### 3. Automatic Transaction Pricing

When creating a transaction, if no price is provided, the system automatically:

1. Looks up the user's base currency
2. Fetches the token price at the transaction timestamp
3. Stores the price in the transaction record
4. Caches the price in the `tokenPrices` table

```typescript
// Transaction creation with automatic pricing
const transaction = await trpc.transactions.create({
  holdingId: "holding-id",
  type: "buy",
  amount: 100,
  // price: not provided - will be fetched automatically
  timestamp: new Date("2024-01-15"),
});
```

## API Endpoints

### Get Portfolio Value

```typescript
// Available via TRPC
const portfolio = await trpc.users.getPortfolioValue();
```

Returns:

```typescript
{
  totalValue: number;
  baseCurrency: string;
  holdings: Array<{
    tokenSymbol: string;
    balance: number;
    currentPrice?: number;
    value?: number;
  }>;
}
```

## Caching Strategy

The system implements intelligent caching with automatic provider fetching:

- **Live prices**: Cached for 1 hour, fetched from provider if not cached
- **Historical prices**: Cached for 24 hours, fetched from provider if not cached
- **Same currency pairs**: Always return 1.0 (no API call)
- **Price fetching**: Always attempts to fetch from providers when needed, regardless of `live` flag
- **1-hour limit**: Provider calls are limited to once per hour per token/currency pair to respect API limits

## Error Handling & Market Limitations

### Manual Price Override

When provider data is unavailable:

- Tokens can be set to "private-company" or "other" type to use manual pricing
- Manual prices are stored in the `tokenPrices` table
- Users can set custom prices via the token management interface

Cache lookup happens first, but if no cached price is available, the system will always attempt to fetch from the appropriate provider (Finnhub, CoinGecko, or ExchangeRate-API) to ensure prices are available when needed.

## Error Handling

The system gracefully handles errors:

- **Missing API keys**: Falls back to manual pricing
- **API failures**: Continues transaction creation without price
- **Missing tokens**: Logs warnings but doesn't fail operations
- **Rate limits**: Implements retry logic (can be enhanced)

## Rate Limiting

Current rate limits per provider:

- **Finnhub**: 60 requests/minute (free), higher limits on paid plans
- **CoinGecko**: 30 requests/minute (free)
- **ExchangeRate-API**: ~100 requests/minute (free)

## Token Type Mapping

The system automatically determines the appropriate provider based on token type:

- `crypto` → CoinGecko (primary)
- `stock`, `etf`, `bond`, `commodity`, `mutual-fund` → Finnhub
- `fiat` → ExchangeRate-API

## Future Enhancements

1. **Batch Processing**: Implement batch API calls for better efficiency
2. **Advanced Caching**: Redis-based caching for distributed systems
3. **Fallback Chain**: Multiple provider fallbacks per asset type
4. **Price Alerts**: Notifications for significant price changes
5. **Real-time Updates**: WebSocket connections for live price streaming

## Testing

Run the pricing service tests:

```bash
cd apps/backend
bun run src/tests/pricing.test.ts
```

## Monitoring

Monitor the system through:

1. **Log analysis**: Check for API failures and rate limits
2. **Database metrics**: Monitor `tokenPrices` table growth
3. **API usage**: Track requests per provider
4. **Cache hit rates**: Measure caching effectiveness

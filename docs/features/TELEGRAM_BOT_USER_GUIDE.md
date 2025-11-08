# Telegram Bot User Guide

## Overview

The Scani Finance Telegram Bot provides a conversational interface to manage your portfolio. It supports natural language queries and gives you access to all features available in the web UI.

## Getting Started

### 1. Authentication

Before using the bot, you need to link your Scani account:

1. Open the Scani web app and go to **Settings → Integrations**
2. Click **"Connect Telegram"**
3. Copy the generated authentication token
4. Send the token to the bot: `/auth YOUR_TOKEN_HERE`

Once authenticated, you can start chatting with the bot!

### 2. Basic Commands

| Command | Description |
|---------|-------------|
| `/start` | Start the bot and see welcome message |
| `/help` | Show available commands and examples |
| `/tools` | List all available tools and capabilities |
| `/auth <token>` | Link your Scani account |
| `/status` | Check authentication status |
| `/reset` | Reset conversation context |
| `/daily` | Generate daily portfolio update |

## Natural Language Queries

You can chat with the bot naturally. Here are some examples:

### Portfolio Overview

- "Show me my portfolio"
- "What's my total portfolio value?"
- "Give me a summary of my investments"

### Holdings Management

- "List all my holdings"
- "Show me what I own"
- "What stocks and crypto do I have?"
- "Update my BTC balance to 2.5"
- "Delete my Apple stock holding"

### Account Operations

- "List all my accounts"
- "Show me my Coinbase account"
- "What's in my brokerage account?"
- "Delete my old bank account"

### Institution Queries

- "Which institutions do I use?"
- "Show my institutions with their values"
- "How much do I have at Chase?"

### Token Search

- "Search for Apple stock"
- "Find BTC"
- "Look up AAPL"
- "What's the price of Bitcoin?"

### Wallet Import

- "Import my Ethereum wallet 0x123..."
- "Add my crypto wallet"
- "Which blockchains are supported?"

### Asset Allocation

- "Show my asset allocation by token type"
- "How is my portfolio distributed?"
- "Break down my holdings by institution"

### Charts and Visualizations

- "Show me a chart of my portfolio"
- "Create a pie chart by token type"
- "Generate a bar chart of my accounts"

### Price Tracking

- "Show me today's price changes"
- "What are my top movers?"
- "Which tokens gained the most?"

## Screenshot Upload

You can send screenshots of your portfolio or brokerage statements, and the bot will analyze them using AI:

1. Take a screenshot of your holdings
2. Send it to the bot
3. The bot will extract holdings data
4. Review and confirm the extracted data

Supported formats: PNG, JPG, JPEG, GIF, WebP

## Available Features

The bot provides access to **32+ features** across these categories:

### 📊 Dashboard (2 features)
- Get portfolio overview
- Get asset allocation by dimension

### 💼 Accounts (6 features)
- List all accounts
- List accounts with summary
- Get account details
- Get account holdings
- Delete account
- List account types

### 📈 Holdings (4 features)
- List all holdings with details
- Update holding
- Delete holding
- Refresh holding price

### 🏦 Institutions (5 features)
- List all institutions
- List user's institutions
- List institutions with summary
- Get institution details
- List institution types

### 🪙 Tokens (2 features)
- List all tokens
- Search tokens

### 🔗 Wallet (3 features)
- List supported blockchains
- Import wallet address
- Detect wallet chains

### 📦 Batch Operations (2 features)
- Bulk create holdings
- Batch update holdings

### 📷 Screenshots (1 feature)
- Parse screenshots with AI

### ⚙️ Settings (4 features)
- Get current user info
- Update user settings
- List supported currencies
- Get base currency

Use `/tools` command to see the complete list with descriptions.

## Tips and Best Practices

### 1. Be Specific

❌ "Show me stuff"
✅ "Show me my portfolio overview"

### 2. Use Account Names

❌ "Show holdings in account 123..."
✅ "Show holdings in my Coinbase account"

### 3. Confirm Destructive Actions

The bot will ask for confirmation before:
- Deleting accounts
- Deleting holdings
- Making bulk changes

### 4. Reset Context if Confused

If the bot seems confused or gives unexpected responses:
- Use `/reset` to clear conversation history
- Start your query fresh

### 5. Check Authentication

If commands aren't working:
- Use `/status` to check if you're authenticated
- Re-authenticate with `/auth` if needed

## Advanced Features

### Daily Digest

Get a daily AI-generated summary of your portfolio:

```
/daily
```

The digest includes:
- Portfolio value changes
- Top movers (gainers and losers)
- Important alerts
- Recommendations

### Portfolio Charts

Request visual representations:

- "Show me a donut chart of my portfolio by tokens"
- "Create a bar chart of my accounts"
- "Generate a pie chart of my asset allocation"

Chart types:
- **Donut charts**: Good for showing distribution
- **Bar charts**: Good for comparing values

Data types:
- **Tokens**: Individual holdings (BTC, AAPL, etc.)
- **Accounts**: Distribution across accounts
- **Institutions**: Distribution across institutions
- **Token Types**: Asset allocation (Crypto, Stocks, Fiat)

### Batch Operations

Import multiple holdings at once:

1. Prepare a list of holdings
2. Ask the bot to import them
3. The bot will create all holdings in one operation

Example:
> "Import these holdings to my Robinhood account: AAPL 10 shares, GOOGL 5 shares, MSFT 8 shares"

## Troubleshooting

### Bot Not Responding

1. Check your internet connection
2. Try `/status` to see if you're authenticated
3. Wait a few seconds and try again
4. Use `/reset` to clear conversation state

### Wrong Results

1. Be more specific in your query
2. Use exact account/institution names
3. Check if you're authenticated with `/status`
4. Try rephrasing your question

### Authentication Issues

1. Make sure you copied the full token
2. Token should be from Settings → Integrations in web app
3. Tokens expire after 1 hour - generate a new one
4. Contact support if issues persist

### Feature Not Working

1. Use `/tools` to check if feature is available
2. Make sure you're authenticated
3. Check if you have the required permissions
4. Try the equivalent feature in the web UI

## Privacy and Security

- All communication is encrypted
- Bot only accesses data you explicitly authorize
- Authentication tokens expire after 1 hour
- You can revoke access anytime in Settings
- No financial transactions are made through the bot
- Bot cannot access your login credentials

## Limitations

Current limitations:
- Cannot create new accounts (web UI only)
- Cannot create new institutions (web UI only)
- No support for creating transactions
- Screenshot parsing requires clear, readable images
- Rate limits apply to prevent abuse

## Support

Need help?
- Use `/help` for quick reference
- Use `/tools` to see all capabilities
- Check the web app documentation
- Contact support through the web app

## Future Features

Coming soon:
- Push notifications for price alerts
- Scheduled daily digests
- Advanced filtering and sorting
- Transaction history tracking
- Budget tracking
- Goal setting and progress

## Examples Gallery

### Example 1: Portfolio Check
```
User: What's my portfolio worth?
Bot: Your portfolio value is $25,430.50
     Accounts: 3
     Holdings: 15
     Top holding: BTC ($12,500)
```

### Example 2: Add Holdings
```
User: Add 100 shares of AAPL to my Robinhood account
Bot: I found the token Apple Inc. (AAPL).
     Adding 100 shares to Robinhood account...
     ✅ Successfully added AAPL holding!
```

### Example 3: Price Check
```
User: What's Bitcoin worth?
Bot: Bitcoin (BTC) current price: $42,350.00
     24h change: +2.5% ($1,030.00)
```

### Example 4: Asset Allocation
```
User: Show my asset allocation
Bot: Your portfolio allocation:
     🪙 Cryptocurrency: 45% ($11,443.73)
     📈 Stocks: 40% ($10,172.20)
     💵 Fiat: 15% ($3,814.57)
```

## Feedback

We're constantly improving the bot! Share your feedback:
- What features would you like to see?
- What isn't working well?
- What could be clearer?

Your input helps make Scani better for everyone.

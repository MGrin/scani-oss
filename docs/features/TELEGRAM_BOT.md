# Telegram Bot Integration

The Scani Telegram bot allows you to manage your personal finance portfolio through natural conversation on Telegram.

## Features

- 🤖 **AI-Powered Assistant**: Chat naturally with an AI agent that understands your financial queries
- 📊 **Portfolio Management**: View your dashboard, accounts, and holdings
- 💰 **Token Information**: Search for stocks and crypto, check current prices
- 📥 **Bulk Import**: Add multiple holdings at once
- 🔒 **Secure**: Token-based authentication with your Scani account

## Setup Instructions

### 1. Create Telegram Bot (Admin Only)

If you haven't created a bot yet:

1. Open Telegram and search for [@BotFather](https://t.me/botfather)
2. Send `/newbot` command
3. Follow prompts to choose name and username for your bot
4. BotFather will give you a bot token - save this securely

### 2. Configure Backend

Add the following environment variables to `apps/backend/.env.local`:

```bash
# Telegram Bot Configuration
TELEGRAM_BOT_TOKEN=your_bot_token_from_botfather

# OpenAI Configuration (required for AI agent)
OPENAI_API_KEY=your_openai_api_key
```

The bot will automatically start when you run the backend server.

### 3. Link Your Telegram Account

1. Start the backend server: `bun dev:backend`
2. In Telegram, search for your bot by username
3. Send `/start` command to the bot
4. The bot will guide you through authentication

#### Authentication Flow

Option 1: **Via Web App** (Recommended)
1. Log into the Scani web app
2. Go to Settings → Integrations
3. Click "Connect Telegram"
4. Copy the generated token
5. In Telegram, send: `/auth YOUR_TOKEN_HERE`

Option 2: **Direct Token** (If you have a Supabase auth token)
1. Get your Supabase authentication token
2. In Telegram, send: `/auth YOUR_TOKEN`

### 4. Start Chatting!

Once authenticated, you can:
- Ask natural questions: "Show me my portfolio"
- Request specific data: "What's the current price of Bitcoin?"
- Manage holdings: "Add 10 shares of AAPL to my investment account"
- Get summaries: "What's my total portfolio value?"

## Available Commands

- `/start` - Initialize the bot and see welcome message
- `/help` - Show all available commands and capabilities
- `/auth <token>` - Link your Telegram account with authentication token
- `/status` - Check if you're authenticated
- `/reset` - Clear conversation history and start fresh

## Natural Language Capabilities

The AI agent can understand and respond to:

### Portfolio Queries
- "Show my portfolio overview"
- "What's my total portfolio value?"
- "List all my accounts"
- "Show holdings in my brokerage account"

### Token Information
- "What's the price of Tesla stock?"
- "Search for Bitcoin"
- "Show me information about AAPL"

### Account Management
- "List all my investment accounts"
- "Show details for account [name]"

### Holdings Management
- "Update quantity of my Apple shares to 15"
- "Delete my Ethereum holding"
- "List all holdings"

### Batch Operations
- "Import these holdings: 10 AAPL, 5 GOOGL, 2 BTC"

## Security Considerations

- ✅ All operations require authentication
- ✅ Telegram user ID is securely mapped to your Scani account
- ✅ Authentication tokens are validated with Supabase
- ✅ No sensitive data is stored in Telegram
- ✅ All financial operations use existing backend security

## Technical Architecture

### Components

1. **Telegram Bot Service** (`apps/telegram-bot`)
   - Handles Telegram API communication
   - Manages conversation state
   - Coordinates with AI agent

2. **AI Agent** 
   - Uses OpenAI GPT-4o-mini for natural language understanding
   - Executes tools based on user intent
   - Maintains conversation context

3. **Tool Executor**
   - 12 tools covering all major operations
   - Direct backend service integration
   - Type-safe parameter validation

4. **Authentication Service**
   - Telegram user mapping in database
   - Token-based account linking
   - Session management

### Database Schema

A new `telegram_users` table stores the mapping:

```sql
CREATE TABLE telegram_users (
  id UUID PRIMARY KEY,
  telegram_id TEXT UNIQUE NOT NULL,
  telegram_username TEXT,
  user_id UUID NOT NULL REFERENCES users(id),
  is_active BOOLEAN DEFAULT true,
  last_interaction_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);
```

### Process Architecture

The Telegram bot runs in the same process as the backend Elysia server:
- No HTTP overhead between bot and backend
- Direct access to all services and use cases
- Graceful shutdown handling
- Automatic restart on server restart

## Troubleshooting

### Bot doesn't respond

1. Check backend logs for errors
2. Verify `TELEGRAM_BOT_TOKEN` is set correctly
3. Ensure `OPENAI_API_KEY` is configured
4. Check bot is started (look for "🤖 Telegram bot started successfully" in logs)

### Authentication fails

1. Make sure you're using a valid Supabase auth token
2. Token must not be expired (tokens typically last 1 hour)
3. Try generating a new token from the web app
4. Check backend logs for specific error messages

### AI responses are slow

1. OpenAI API response time varies (typically 2-5 seconds)
2. Tool execution adds additional time for database queries
3. Consider upgrading to faster OpenAI model if needed

### "Tool execution failed" errors

1. Check that the user has necessary permissions
2. Verify data integrity (e.g., account IDs exist)
3. Review backend logs for specific service errors

## Development

### Running the Bot Locally

```bash
# Install dependencies
bun install

# Start backend with bot
cd apps/backend
bun dev

# Check logs for bot status
# You should see: "🤖 Telegram bot started successfully"
```

### Testing Tools

Test individual tools directly in the conversation:

```
"Test dashboard tool" → Calls getDashboardOverview
"List accounts" → Calls listAccounts
"Search for AAPL" → Calls searchTokens
```

### Adding New Tools

1. Add tool definition in `apps/telegram-bot/src/tools.ts`
2. Implement executor in `apps/telegram-bot/src/tool-executor.ts`
3. Update system prompt in `ai-agent.ts` if needed
4. Test with natural language queries

## Limitations

- Conversation history is stored in-memory (resets on server restart)
- Maximum 20 messages retained per conversation
- No support for images or media uploads currently
- Single-user conversations only (no group chat support yet)

## Future Enhancements

Potential features for future versions:

- 📊 **Charts and Visualizations**: Generate portfolio charts
- 🔔 **Price Alerts**: Set up Telegram notifications for price changes
- 📱 **Inline Keyboards**: Quick action buttons for common tasks
- 🗂️ **File Imports**: Upload CSV/Excel files for bulk import
- 👥 **Multi-user**: Support for family/shared accounts
- 🧠 **Persistent Memory**: Store conversation context in database
- 🌍 **Multi-language**: Support for multiple languages

## Support

For issues or questions:
1. Check logs in the backend console
2. Review this documentation
3. Create an issue in the GitHub repository
4. Check Discord/Slack for community help

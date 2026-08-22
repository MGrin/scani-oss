# `ai-openai/`

OpenAI chat completions (text + vision).

- **Upstream**: `https://api.openai.com/v1`.
- **Capabilities**: `ai-inference`.
- **Auth**: `Authorization: Bearer ${OPENAI_API_KEY}`.
- **Env**: `OPENAI_API_KEY` (required). The model is pinned to
  `gpt-5.6-luna` for both text and screenshot parsing and is not
  configurable — see the header of `index.ts` for why swapping the id
  alone would misconfigure four other fields (SC-588).
- **Rate limit**: namespace `ai-openai`.
- **Notes**: thin wrapper over the shared `_chat-completions.ts` client
  at `providers/_chat-completions.ts`. Used by AIRouter as the default
  AI provider. Vision path takes base64 + mimeType; text path takes
  prompt + temperature/maxTokens.

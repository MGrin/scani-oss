# `ai-openai/`

OpenAI chat completions (text + vision).

- **Upstream**: `https://api.openai.com/v1`.
- **Capabilities**: `ai-inference`.
- **Auth**: `Authorization: Bearer ${OPENAI_API_KEY}`.
- **Env**: `OPENAI_API_KEY` (required), `OPENAI_VISION_MODEL` (optional
  override; defaults to gpt-4o-mini for screenshot parsing).
- **Rate limit**: namespace `ai-openai`.
- **Notes**: thin wrapper over the shared `_chat-completions.ts` client
  at `providers/_chat-completions.ts`. Used by AIRouter as the default
  AI provider. Vision path takes base64 + mimeType; text path takes
  prompt + temperature/maxTokens.

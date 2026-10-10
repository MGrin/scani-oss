# `ai-openai/`

OpenAI Responses API (text + vision), `POST /v1/responses` with
`store: false` (SC-1581).

- **Upstream**: `https://api.openai.com/v1`.
- **Capabilities**: `ai-inference`.
- **Auth**: `Authorization: Bearer ${OPENAI_API_KEY}`.
- **Env**: `OPENAI_API_KEY` (required). The model is pinned to
  `gpt-5.6-luna` for both text and screenshot parsing and is not
  configurable — see the header of `index.ts` for why swapping the id
  alone would misconfigure three other fields (SC-588).
- **Rate limit**: namespace `ai-openai`.
- **Notes**: thin wrapper over the shared Responses client at
  `providers/_openai-responses.ts`. Used by AIRouter as the default
  AI provider. Vision path takes base64 + mimeType; text path takes
  prompt + temperature/maxTokens.

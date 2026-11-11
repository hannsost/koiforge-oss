# AI providers

KoiForge is vendor-neutral. It uses the OpenAI **Chat Completions** protocol, which almost every provider and
local runtime supports.

## 1. AI assistant (AIP)

Configure in the console under *KI-Assistent → Agenten & KI* (owner rights): provider label, base URL, model and an
optional API key. Keys are stored server-side and never returned to the browser (`hasKey` only).

Allowed base URLs (exact match):

- `https://api.openai.com/v1` (always)
- `http://localhost:11434/v1`, `http://127.0.0.1:11434/v1` (Ollama, non-production only)
- every entry of `KOIFORGE_AI_BASE_URLS`, e.g.
  `KOIFORGE_AI_BASE_URLS=https://api.mistral.ai/v1,https://openrouter.ai/api/v1,http://localhost:1234/v1`

URLs with credentials, query strings or fragments are rejected; redirects never forward the key.

## 2. Mission planning & self-extension

| `KOIFORGE_EXTENSION_BACKEND` | Behaviour |
| --- | --- |
| `codex` (optional) | Uses the local Codex CLI (`KOIFORGE_CODEX_BIN`, `KOIFORGE_CODEX_MODEL`, `KOIFORGE_CODEX_REASONING_EFFORT`). |
| `api` (default) | Uses the AIP endpoint configured above — works with Ollama, LM Studio, Mistral, OpenRouter, OpenAI and others. |

Set `KOIFORGE_EXTENSION_BACKEND=codex` to opt into the local Codex CLI, with `gpt-6-astra` / `xhigh` by default.

Set `KOIFORGE_GENERATION_DISABLED=1` to run without any model (only already verified capabilities are reused).

## Examples

| Provider | Base URL | Model |
| --- | --- | --- |
| Ollama | `http://localhost:11434/v1` | `llama3.2`, `qwen2.5-coder` |
| LM Studio | `http://localhost:1234/v1` | loaded model |
| vLLM | `http://<host>:8000/v1` | served model |
| Mistral | `https://api.mistral.ai/v1` | `mistral-small-latest` |
| OpenRouter | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-4`, `google/gemini-2.5-flash` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |

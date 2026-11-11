# Configuration reference

All configuration is via environment variables. Never commit real values.

## Server

| Variable | Default | Description |
| --- | --- | --- |
| `HOST`, `PORT` | `0.0.0.0`, `3000` | API listen address |
| `KOIFORGE_API_PORT`, `KOIFORGE_WEB_PORT` | `3100`, `5173` | Ports used by `pnpm dev:linux` |
| `KOIFORGE_STATE_ROOT` | `./.koiforge` | Persistent state |
| `KOIFORGE_IMPORT_DATA_ROOT` | `./.koiforge` | Root for imported datasets |
| `KOIFORGE_PUBLIC_ORIGIN` | `http://localhost:5173` | Console origin (HTTPS required in production) |
| `KOIFORGE_BOOTSTRAP_TOKEN` | – | Setup code (≥ 32 characters) for first-owner setup in production |
| `NODE_ENV` | – | `production` enables production guardrails |

## Single sign-on (optional)

| Variable | Description |
| --- | --- |
| `KOIFORGE_OIDC_ISSUER` | OIDC issuer URL |
| `KOIFORGE_OIDC_CLIENT_ID` | Client ID |
| `KOIFORGE_OIDC_LABEL` | Login button label |
| `KOIFORGE_OIDC_ADMIN_ROLE` | Role claim that grants admin rights |
| `KOIFORGE_OIDC_BACKCHANNEL_ORIGIN` | Internal origin for server-to-IdP calls (optional) |

## AI and self-extension

| Variable | Default | Description |
| --- | --- | --- |
| `KOIFORGE_AI_BASE_URLS` | – | Extra allowed AI base URLs (comma-separated, exact match) |
| `KOIFORGE_EXTENSION_BACKEND` | `api` | `api` (configured OpenAI-compatible AIP endpoint); opt into the local Codex CLI with `KOIFORGE_EXTENSION_BACKEND=codex` |
| `KOIFORGE_CODEX_BIN` | `codex` | Path to the Codex CLI |
| `KOIFORGE_CODEX_MODEL` | `gpt-6-astra` | Model for the Codex backend |
| `KOIFORGE_CODEX_REASONING_EFFORT` | `xhigh` | Reasoning effort for the Codex backend |
| `KOIFORGE_GENERATION_DISABLED` | – | `1` disables generation entirely |

## Monitoring (optional)

| Variable | Description |
| --- | --- |
| `KOIFORGE_PROMETHEUS_URL` | Prometheus endpoint for the monitoring view |
| `KOIFORGE_GITLAB_QUEUE_TOKEN`, `KOIFORGE_GITLAB_QUEUE_PROJECTS` | Optional GitLab CI queue monitor (read-only token, ≤ 32 project paths) |

## MCP server

See [MCP-AND-SKILLS.md](MCP-AND-SKILLS.md).

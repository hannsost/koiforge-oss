# KoiForge MCP server

See the main [README](../README.md#mcp-server) for the full guide.


`mcp/` contains a dependency-free [Model Context Protocol](https://modelcontextprotocol.io) server (Node.js ≥ 20,
stdio transport) that exposes KoiForge's key operations to any MCP client — Claude, Codex, Cursor, LM Studio,
Grok Bot or your own agent running a local model.

### Tools

| Tool | Kind | Purpose |
| --- | --- | --- |
| `koiforge_health` | read | API health and version |
| `koiforge_session` | read | Current user, tenant and roles |
| `koiforge_list_projects` | read | Projects |
| `koiforge_list_datasets` | read | Registered datasets |
| `koiforge_get_dataset` | read | One dataset with schema |
| `koiforge_preview_dataset` | read | Preview rows (search, sort, limit) |
| `koiforge_get_object` | read | Business object with relationships and provenance |
| `koiforge_list_missions` | read | Missions |
| `koiforge_get_mission` | read | Mission with plan, results, evidence |
| `koiforge_list_cases` | read | Clarification cases |
| `koiforge_get_case` | read | One case with history |
| `koiforge_list_routines` | read | Saved routines |
| `koiforge_create_mission` | write | Ask a business question against a dataset |
| `koiforge_run_mission` | write | Run a mission (requires `confirmed: true`) |

Write tools are hidden when `KOIFORGE_READ_ONLY=true`. Errors from the API are returned as tool errors
(`isError: true`) with the HTTP status, never with credentials.

### Configuration

All settings come from environment variables — **no secrets are stored in this repository**.

| Variable | Example | Required | Description |
| --- | --- | --- | --- |
| `KOIFORGE_BASE_URL` | `http://127.0.0.1:3100` | yes | KoiForge control-plane API base URL |
| `KOIFORGE_SESSION_TOKEN` | `<session-token>` | one of | Value of the `koiforge_session` cookie |
| `KOIFORGE_EMAIL / KOIFORGE_PASSWORD` | `<user> / <password>` | one of | Log in at startup via `/api/auth/login` |
| `KOIFORGE_READ_ONLY` | `true` | no | Hide all write tools |

### Client setup

**Claude Desktop / Cursor / generic MCP JSON** (`claude_desktop_config.json`, `.cursor/mcp.json`, …):

```json
{
  "mcpServers": {
    "koiforge": {
      "command": "node",
      "args": ["/absolute/path/to/koiforge/mcp/src/server.mjs"],
      "env": {
        "KOIFORGE_BASE_URL": "http://127.0.0.1:3100",
        "KOIFORGE_EMAIL": "<user@example.org>",
        "KOIFORGE_PASSWORD": "<password>"
      }
    }
  }
}
```

**Claude Code:**

```sh
claude mcp add koiforge --env KOIFORGE_BASE_URL=http://127.0.0.1:3100 --env KOIFORGE_EMAIL=<user@example.org> --env KOIFORGE_PASSWORD=<password> -- node /absolute/path/to/koiforge/mcp/src/server.mjs
```

**OpenAI Codex CLI** (`~/.codex/config.toml`):

```toml
[mcp_servers.koiforge]
command = "node"
args = ["/absolute/path/to/koiforge/mcp/src/server.mjs"]
env = { KOIFORGE_BASE_URL = "http://127.0.0.1:3100", KOIFORGE_EMAIL = "<user@example.org>", KOIFORGE_PASSWORD = "<password>" }
```

**Run / test directly:**

```sh
cd mcp && npm test                       # unit tests against a mock API
KOIFORGE_BASE_URL=http://127.0.0.1:3100 node mcp/src/server.mjs   # speaks MCP on stdin/stdout
```


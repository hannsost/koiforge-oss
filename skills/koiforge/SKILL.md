---
name: koiforge
description: Answer operational business questions with KoiForge — inspect datasets and business objects, create missions that check data (freshness, completeness, duplicates, relationships, overdue orders), run them with human confirmation, and follow up on resulting cases. Use when the user asks what is wrong or late in their data, wants a reproducible check, or needs evidence for a finding.
---

# KoiForge data operations

KoiForge connects business questions with data sources, confirmed rules and traceable results. A **mission**
is a question checked against a dataset; results become **findings**, which can turn into **cases**; repeatable
missions are saved as **routines**.

## Tools

Use the `koiforge` MCP server (see `mcp/README.md`). Without MCP, use the REST API at `$KOIFORGE_BASE_URL`
with the `koiforge_session` cookie and the header `x-koiforge-request: 1` on writes.

| Goal | MCP tool | REST |
| --- | --- | --- |
| Is the instance up? | `koiforge_health` | `GET /health` |
| Who am I? | `koiforge_session` | `GET /api/auth/session` |
| Data sources | `koiforge_list_datasets`, `koiforge_get_dataset` | `GET /api/datasets[/{id}]` |
| Look at rows | `koiforge_preview_dataset` | `GET /api/datasets/{id}/preview?limit=&q=` |
| Business object | `koiforge_get_object` | `GET /api/objects/{type}/{id}` |
| Missions | `koiforge_list_missions`, `koiforge_get_mission` | `GET /api/missions[/{id}]` |
| New question | `koiforge_create_mission` | `POST /api/missions` |
| Run (confirmed) | `koiforge_run_mission` | `POST /api/missions/{id}/run` |
| Cases / routines | `koiforge_list_cases`, `koiforge_get_case`, `koiforge_list_routines` | `GET /api/cases`, `/api/routines` |

## Workflow

1. **Orient.** `koiforge_health`, then `koiforge_session` to confirm tenant and role.
2. **Pick the data.** `koiforge_list_datasets`; inspect the schema with `koiforge_get_dataset` and sample rows with
   `koiforge_preview_dataset`. Prefer datasets with confirmed semantic models.
3. **Check for existing work.** Look at `koiforge_list_missions` and `koiforge_list_routines` before creating new ones.
4. **Ask the question.** `koiforge_create_mission` with a precise business question (≤ 1000 chars) and the dataset ID.
5. **Review the plan.** `koiforge_get_mission` — explain the planned rule, data snapshot (revision) and cut-off date
   to the user.
6. **Run only with confirmation.** After the user agrees, call `koiforge_run_mission` with the mission `revision`
   and `confirmed: true`. Pass any `binding`/`rule` fields the plan requires via `extra`.
7. **Report with evidence.** Summarise findings with counts and example IDs from the mission result; point to
   cases (`koiforge_list_cases`) for follow-up. Never claim a finding is resolved unless the data shows it.

## Rules

- Do not fabricate numbers — every figure must come from a tool result.
- Missing or duplicate IDs are findings, not "resolved".
- Runs and case transitions need explicit human confirmation.
- Credentials only via environment variables; never echo session tokens.
- Use `KOIFORGE_READ_ONLY=true` for analysis-only tasks.

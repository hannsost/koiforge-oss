# Thematic monitoring dashboards

Related: KoiForge #1, #2, SOL-0010; implementation in MR !7.

The existing `#/monitoring` page now provides five fixed views. This does not
provision another dashboard server or change the Prometheus migration.

| View | Contents |
| --- | --- |
| Überblick | HTTPS, CPU, last reported backup, alerts; four histories |
| Server & Cluster | Kubernetes-node CPU/RAM/root disk, unready pods, unavailable replicas |
| Anwendungen | Per-target/per-observer HTTPS and TLS table, probe age, availability histories |
| GitLab & CI | Queue, oldest pending age, separate Duo counts, Flux and deployment histories |
| Backups & Sicherheit | Backup age, minimum observed certificate lifetime, explicit restore-test gap |

## Behaviour and data limits

- Shared 15m/1h/6h/24h/7d range, deep links such as
  `#/monitoring?view=applications&range=6h`, back/forward navigation.
- Auto-refresh every 60 seconds while visible; optional pause; manual refresh.
  Previous data loses its current/healthy status after a failed fetch or 3 minutes
  without a successful fetch. Each source/chart fails independently.
- Superseded requests are aborted and cannot overwrite a newer range.
  No smoothing across missing Prometheus samples. Range selection does not extend
  upstream retention; currently the operating setup retains only about 48 hours.
- Values are measured signals, not an SLA or a guarantee of service health.
  Missing p95 latency, request error rates, restore tests, queue history/ETA and
  separate website-server resource metrics are explicitly identified as gaps.
- No job actions, restarts, configuration changes or credentials in the browser.

## Backend

`GET /api/monitoring/endpoints` uses the existing session/view guard and returns
only a fixed inventory and public fields. Eleven expected targets are represented
even when absent. Receiver and CX23 observations are separate (45/15 minute
freshness budgets, at most 30 seconds future skew). Conflicting duplicate series,
missing data, invalid values and old observations never become a healthy row.

HTTPS/TLS aggregate queries use the same fixed target/observer inventory, require
complete coverage and fresh observations at each query evaluation time. This also
applies to histories. TLS zero timestamps do not become fictitious expiry dates.
Prometheus response bodies are bounded to 1 MiB and endpoint vectors to 256 rows.
Queries, URLs and arbitrary labels cannot be supplied by the client.

Missing Kubernetes/Flux series no longer become a fabricated zero via `or vector(0)`.
Flux failures are counts, not booleans; unavailable deployment *replicas* are named
accurately. `severity=page` is mapped to critical. Null summary measurements mark
the source degraded.

GitLab configuration is documented separately in (interne Dokumentation, nicht veröffentlicht).
It requires a dedicated read-only credential; dashboard publication alone does not
configure that data source. The previous skill-level ban on secret automation no
longer applies under NeuroFunken skill 0.4.0, but actual permissions still apply.

## Verification

```sh
pnpm --filter '@koiforge/control-plane-api...' --filter '@koiforge/console-web...' build
pnpm --filter @koiforge/control-plane-api test
pnpm --filter @koiforge/e2e-tests typecheck
pnpm --filter @koiforge/e2e-tests exec playwright install chromium
pnpm --filter @koiforge/e2e-tests test:monitoring
node scripts/monitoring-promql-fixture.mjs | promtool test rules /dev/stdin
```

For a system Chromium use `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`.
The browser suite starts a local production-build preview and intercepts API calls
with synthetic fixtures: no production login, cookies or personal browser profile.
Screenshots are in the ignored `packages/e2e-tests/test-results/` directory.

PromQL fixtures cover complete/fresh, missing, future, down, absent, conflicting
observers and stale observations. Run those locally with a writable temporary
directory, not inside the read-only production Prometheus container.

## Release gate (2026-09-28)

Verified locally: 348/348 API tests, 8/8 browser scenarios, 7/7 PromQL scenarios,
API/web production builds, E2E TypeScript and desktop/mobile visual inspection.

Local implementation/testing does **not** imply production activation. The source
baseline is main `a4e92487`; production still uses digest
`sha256:1a825d965e598c4f415cea4090541bc7b9fa5c4471c85785175d41ce9d671441`.
Read-only validation accepted the new HTTPS/TLS queries; live probe telemetry lacked
valid observation timestamps, so the new aggregates correctly returned no value.

Before rollout: refresh current main/GitOps and coordination notes, complete CI,
build the integrated image, pin its digest through the existing GitOps release,
verify owner access and all five views with real data. Preserve independent SSO and
branding work. Existing OS-isolation integration tests require systemd/bubblewrap
and fail in the current plain Node CI container; do not skip them, grant a general
privileged runner, or report a green pipeline without resolving that test environment.
The image job now requires `verify` as well as Helm validation.

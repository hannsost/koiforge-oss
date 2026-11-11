/** Public inventory, not user-supplied URLs or arbitrary Prometheus labels. */
const TARGETS = {
  // PalmScout Web/API are intentionally paused (owner decision 2026-10-08).
  // Re-enable together with their GitOps external_target_expected rules.
  fireflint: 'Fireflint',
  koiforge: 'KoiForge', login: 'Login / Keycloak', mcp: 'NeuroFunken MCP', support: 'SolveIT',
  apex: 'Website', www: 'Website www', 'mail-mx00': 'Mail MX00', 'mail-mx01': 'Mail MX01',
} as const;
const OBSERVERS = { 'external-probe-receiver': { label: 'Externer Prüfer', maxAge: 2700 }, 'external-probe-cx23': { label: 'Server-Prüfer', maxAge: 900 } } as const;
const METRICS = ['neurofunken_external_https_up', 'neurofunken_external_tls_expiry_timestamp_seconds', 'neurofunken_external_probe_timestamp_seconds'] as const;
// Mail is checked with SMTP/STARTTLS, not HTTPS. Keep its failures visible in
// the endpoint table without making the separate web certificate KPI unknown.
const HTTPS_TARGETS = Object.keys(TARGETS).filter(id => !id.startsWith('mail-'));

export const ENDPOINT_QUERY = `{__name__=~"${METRICS.join('|')}",job=~"${Object.keys(OBSERVERS).join('|')}",target_id=~"${Object.keys(TARGETS).join('|')}"}`;

/** Coverage and freshness gates apply at each evaluation time, including range queries. */
export function endpointAggregateQuery(kind: 'https' | 'tls'): string {
  const labels = `job=~"${Object.keys(OBSERVERS).join('|')}",target_id=~"${HTTPS_TARGETS.join('|')}"`;
  const metric = `${kind === 'https' ? METRICS[0] : METRICS[1]}{${labels}}`;
  const freshness = Object.entries(OBSERVERS).map(([job, observer]) => {
    const stamp = `${METRICS[2]}{job="${job}"}`;
    return `((${stamp} > time() - ${observer.maxAge}) and (${stamp} <= time() + 30))`;
  }).join(' or ');
  const measured = kind === 'https' ? `((${metric} == 0) or (${metric} == 1))` : `(${metric} > 0)`;
  const valid = `(${measured} and on(job,target_id) (${freshness}))`;
  const value = kind === 'https' ? `min(${valid})` : `(min(${valid}) - time()) / 86400`;
  return `(${value}) and (count(${valid}) == count(${metric})) and (count(count by(job,target_id) (${metric})) == count(${metric})) and (count(count by(target_id) (${valid})) == ${HTTPS_TARGETS.length})`;
}
export interface MonitoringEndpoint {
  id: string; name: string; observer: string | null; state: 'ok' | 'critical' | 'unknown';
  checkedAt: string | null; maxAgeSeconds: number; tlsDays: number | null;
  reason: 'fresh' | 'stale' | 'missing' | 'ambiguous';
}

/** Accept a bounded vector and emit only fixed public fields. Conflicting series fail closed. */
export function parseEndpoints(payload: unknown, now = Date.now()): MonitoringEndpoint[] {
  const data = payload as { status?: string; data?: { resultType?: string; result?: Array<{ metric?: Record<string, string>; value?: unknown[] }> } };
  if (data?.status !== 'success' || data.data?.resultType !== 'vector' || !Array.isArray(data.data.result) || data.data.result.length > 256) throw new Error('Invalid endpoint metrics');
  const rows = new Map<string, { values: Map<string, number>; duplicate: boolean }>();
  for (const item of data.data.result) {
    const { target_id: target, job, __name__: metric } = item.metric ?? {};
    if (!Object.hasOwn(TARGETS, target ?? '') || !Object.hasOwn(OBSERVERS, job ?? '') || !(METRICS as readonly string[]).includes(metric ?? '')) continue;
    const key = `${target}:${job}`;
    const row = rows.get(key) ?? { values: new Map<string, number>(), duplicate: false };
    if (row.values.has(metric!)) row.duplicate = true;
    const tuple = item.value;
    const value = Array.isArray(tuple) && typeof tuple[1] === 'string' && tuple[1].trim() ? Number(tuple[1]) : NaN;
    row.values.set(metric!, value);
    rows.set(key, row);
  }
  const result: MonitoringEndpoint[] = [];
  for (const [id, name] of Object.entries(TARGETS)) {
    let found = false;
    for (const [job, observer] of Object.entries(OBSERVERS)) {
      const row = rows.get(`${id}:${job}`);
      if (!row) continue;
      found = true;
      const stamp = row.values.get(METRICS[2]);
      const validStamp = stamp != null && Number.isFinite(stamp) && stamp > 0 && stamp * 1000 <= now + 30_000 && stamp * 1000 <= 8.64e15;
      const fresh = validStamp && now / 1000 - stamp <= observer.maxAge;
      const up = row.values.get(METRICS[0]);
      const validUp = up === 0 || up === 1;
      const expiry = row.values.get(METRICS[1]);
      result.push({ id, name, observer: observer.label, maxAgeSeconds: observer.maxAge,
        state: row.duplicate || !fresh || !validUp ? 'unknown' : up === 1 ? 'ok' : 'critical',
        checkedAt: validStamp ? new Date(stamp * 1000).toISOString() : null,
        tlsDays: !row.duplicate && fresh && expiry != null && Number.isFinite(expiry) && expiry > 0 ? (expiry - now / 1000) / 86400 : null,
        reason: row.duplicate ? 'ambiguous' : !validStamp || !validUp ? 'missing' : fresh ? 'fresh' : 'stale',
      });
    }
    if (!found) result.push({ id, name, observer: null, state: 'unknown', checkedAt: null, tlsDays: null, maxAgeSeconds: 0, reason: 'missing' });
  }
  return result;
}

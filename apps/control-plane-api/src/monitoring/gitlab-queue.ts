// GitLab is the source of truth; this cache never schedules or mutates jobs.
export interface QueueCounts {
  running: number;
  pending: number;
  duoRunning: number;
  duoPending: number;
  upcoming: number;
  resourceWaiting: number;
  scheduled: number;
  canceling: number;
}

export interface QueueProject {
  project: string;
  url: string;
  counts: QueueCounts | null;
  oldestPendingSeconds: number | null;
}

export interface GitLabQueueSnapshot {
  source: 'ready' | 'degraded';
  observedAt: string;
  counts: QueueCounts | null;
  oldestPendingSeconds: number | null;
  projects: QueueProject[];
}

export interface GitLabQueueService {
  configured: boolean;
  snapshot(): Promise<GitLabQueueSnapshot>;
}

interface Job {
  id: number;
  status: string;
  tag_list?: string[];
  queued_duration?: number | null;
  created_at: string;
  pipeline: { id: number; source?: string };
}

const scopes = ['created', 'pending', 'running', 'preparing', 'waiting_for_resource', 'scheduled', 'canceling'];
const activePipelines = new Set(['created', 'pending', 'running', 'preparing', 'waiting_for_resource', 'scheduled']);
const emptyCounts = (): QueueCounts => ({ running: 0, pending: 0, duoRunning: 0, duoPending: 0,
  upcoming: 0, resourceWaiting: 0, scheduled: 0, canceling: 0 });

export function createGitLabQueueService(options: {
  token?: string;
  projects?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): GitLabQueueService {
  const projects = [...new Set((options.projects ?? '').split(',').map(p => p.trim()).filter(Boolean))];
  if (projects.length > 32 || projects.some(p => !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_][a-zA-Z0-9_.-]*)+$/.test(p))) {
    throw new Error('KOIFORGE_GITLAB_QUEUE_PROJECTS requires at most 32 explicit project paths.');
  }
  const configured = Boolean(options.token && projects.length);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  let cache: GitLabQueueSnapshot | undefined;
  let expiresAt = 0;
  let inFlight: Promise<GitLabQueueSnapshot> | undefined;

  async function collect(): Promise<GitLabQueueSnapshot> {
    const observedAt = new Date(now()).toISOString();
    const signal = AbortSignal.timeout(20_000);
    let requests = 0;
    async function request(path: string, params = new URLSearchParams()) {
      if (++requests > 160) throw new Error('Queue request limit');
      const url = new URL(`/api/v4/${path}`, 'https://gitlab.com');
      url.search = params.toString();
      const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal,
        headers: { Accept: 'application/json', 'PRIVATE-TOKEN': options.token! } });
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
        throw new Error('Queue upstream unavailable');
      }
      // Bound streamed responses too; do not trust Content-Length alone.
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Queue response missing');
      const decoder = new TextDecoder();
      let bytes = 0;
      let body = '';
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 2 * 1024 * 1024) throw new Error('Queue response limit');
          body += decoder.decode(part.value, { stream: true });
        }
        body += decoder.decode();
      } finally { await reader.cancel(); }
      return { data: JSON.parse(body) as unknown, next: response.headers.get('x-next-page') };
    }

    async function projectSnapshot(project: string): Promise<QueueProject> {
      const url = `https://gitlab.com/${project}/-/pipelines`;
      try {
        const base = `projects/${encodeURIComponent(project)}`;
        const jobs = new Map<number, Job>();
        let page = 1;
        for (;;) {
          const params = new URLSearchParams({ per_page: '100', page: String(page) });
          scopes.forEach(scope => params.append('scope[]', scope));
          const { data, next } = await request(`${base}/jobs`, params);
          if (!Array.isArray(data)) throw new Error('Invalid jobs');
          for (const job of data as Job[]) {
            if (!Number.isSafeInteger(job.id) || !scopes.includes(job.status)
              || !Number.isSafeInteger(job.pipeline?.id)
              || (job.tag_list !== undefined && (!Array.isArray(job.tag_list) || job.tag_list.some(t => typeof t !== 'string')))) {
              throw new Error('Invalid job');
            }
            jobs.set(job.id, job);
          }
          if (next === '') break;
          // Some proxies omit pagination headers. A full page must not be treated as complete.
          if (next === null && data.length < 100) break;
          const nextPage = next === null ? page + 1 : Number(next);
          if (!Number.isSafeInteger(nextPage) || nextPage <= page || nextPage > 20) throw new Error('Pagination limit');
          page = nextPage;
        }
        const pipelineStates = new Map<number, string>();
        for (const job of jobs.values()) {
          if (job.status !== 'created' || pipelineStates.has(job.pipeline.id)) continue;
          const { data } = await request(`${base}/pipelines/${job.pipeline.id}`);
          const status = (data as { status?: string })?.status;
          if (typeof status !== 'string') throw new Error('Invalid pipeline');
          pipelineStates.set(job.pipeline.id, status);
        }
        const counts = emptyCounts();
        let oldestPendingSeconds: number | null = null;
        let pendingAgesComplete = true;
        for (const job of jobs.values()) {
          const duo = job.pipeline.source === 'duo_workflow' || job.tag_list?.includes('gitlab--duo');
          if (job.status === 'running' || job.status === 'preparing') counts[duo ? 'duoRunning' : 'running']++;
          else if (job.status === 'pending') {
            counts[duo ? 'duoPending' : 'pending']++;
            if (!duo && typeof job.queued_duration === 'number' && Number.isFinite(job.queued_duration) && job.queued_duration >= 0) {
              oldestPendingSeconds = Math.max(oldestPendingSeconds ?? 0, job.queued_duration);
            } else if (!duo) pendingAgesComplete = false;
          } else if (job.status === 'created' && activePipelines.has(pipelineStates.get(job.pipeline.id)!)) counts.upcoming++;
          else if (job.status === 'waiting_for_resource') counts.resourceWaiting++;
          else if (job.status === 'scheduled') counts.scheduled++;
          else if (job.status === 'canceling') counts.canceling++;
        }
        return { project, url, counts, oldestPendingSeconds: pendingAgesComplete ? oldestPendingSeconds : null };
      } catch {
        // No upstream bodies, project variables, job logs or credentials leave this adapter.
        return { project, url, counts: null, oldestPendingSeconds: null };
      }
    }

    const rows: QueueProject[] = [];
    for (let i = 0; i < projects.length; i += 4) {
      rows.push(...await Promise.all(projects.slice(i, i + 4).map(projectSnapshot)));
    }
    const complete = rows.every(row => row.counts !== null);
    const totals = emptyCounts();
    for (const row of rows) if (row.counts) {
      for (const key of Object.keys(totals) as Array<keyof QueueCounts>) totals[key] += row.counts[key];
    }
    const ages = rows.flatMap(row => row.oldestPendingSeconds === null ? [] : [row.oldestPendingSeconds]);
    const agesComplete = rows.every(row => row.counts?.pending === 0 || row.oldestPendingSeconds !== null);
    return { source: complete ? 'ready' : 'degraded', observedAt, counts: complete ? totals : null,
      oldestPendingSeconds: complete && agesComplete && ages.length ? Math.max(...ages) : null, projects: rows };
  }

  return {
    configured,
    async snapshot() {
      if (!configured) throw new Error('GitLab queue not configured');
      if (cache && now() < expiresAt) return cache;
      if (!inFlight) inFlight = collect().then(result => {
        cache = result;
        expiresAt = now() + 60_000;
        return result;
      }).finally(() => { inFlight = undefined; });
      return inFlight;
    },
  };
}

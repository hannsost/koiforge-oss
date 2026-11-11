#!/usr/bin/env node
// KoiForge MCP server: exposes the KoiForge control-plane API as MCP tools.
// Configuration (environment only — never commit real values):
//   KOIFORGE_BASE_URL       e.g. http://127.0.0.1:3100 (required)
//   KOIFORGE_SESSION_TOKEN  value of the `koiforge_session` cookie, or use:
//   KOIFORGE_EMAIL / KOIFORGE_PASSWORD  to log in at startup via /api/auth/login
//   KOIFORGE_READ_ONLY=true hide all write tools
import { randomUUID } from 'node:crypto';
import { createServer, createHttpClient, seg } from './mcp-stdio.mjs';

export function buildTools(env = process.env) {
  let session = env.KOIFORGE_SESSION_TOKEN || '';
  async function login() {
    const raw = createHttpClient({ baseUrl: env.KOIFORGE_BASE_URL });
    const { response } = await raw('POST', '/api/auth/login', {
      body: { email: env.KOIFORGE_EMAIL, password: env.KOIFORGE_PASSWORD },
      extraHeaders: { 'x-koiforge-request': '1' },
    });
    const cookies = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];
    const match = cookies.join(';').match(/koiforge_session=([^;]+)/);
    if (!match) throw new Error('Login did not return a session');
    session = match[1];
  }
  const http = createHttpClient({
    baseUrl: env.KOIFORGE_BASE_URL,
    headers: async () => {
      if (!session && env.KOIFORGE_EMAIL && env.KOIFORGE_PASSWORD) await login();
      // Writes require the CSRF marker header; it is harmless on reads.
      return { 'x-koiforge-request': '1', ...(session ? { cookie: `koiforge_session=${session}` } : {}) };
    },
  });
  const ro = { readOnlyHint: true, openWorldHint: false };
  const get = (path, query) => async () => (await http('GET', path, { query })).data;
  const id = { type: 'string' };

  const tools = [
    { name: 'koiforge_health', description: 'Check KoiForge API health and version.', annotations: ro,
      inputSchema: { type: 'object', properties: {} }, handler: get('/health') },
    { name: 'koiforge_session', description: 'Show the authenticated user, tenant and roles.', annotations: ro,
      inputSchema: { type: 'object', properties: {} }, handler: get('/api/auth/session') },
    { name: 'koiforge_list_projects', description: 'List projects.', annotations: ro,
      inputSchema: { type: 'object', properties: {} }, handler: get('/api/projects') },
    { name: 'koiforge_list_datasets', description: 'List registered datasets (data sources) with schema metadata.', annotations: ro,
      inputSchema: { type: 'object', properties: {} }, handler: get('/api/datasets') },
    { name: 'koiforge_get_dataset', description: 'Get one dataset with its schema.', annotations: ro,
      inputSchema: { type: 'object', required: ['dataset_id'], properties: { dataset_id: id } },
      handler: async (a) => (await http('GET', `/api/datasets/${seg(a.dataset_id, 'dataset_id')}`)).data },
    { name: 'koiforge_preview_dataset', description: 'Preview rows of a dataset with optional search and sorting.', annotations: ro,
      inputSchema: { type: 'object', required: ['dataset_id'], properties: { dataset_id: id,
        limit: { type: 'integer', minimum: 1, maximum: 500 }, q: { type: 'string' },
        sortBy: { type: 'string' }, sortDir: { type: 'string', enum: ['asc', 'desc'] } } },
      handler: async (a) => (await http('GET', `/api/datasets/${seg(a.dataset_id, 'dataset_id')}/preview`,
        { query: { limit: a.limit, q: a.q, sortBy: a.sortBy, sortDir: a.sortDir } })).data },
    { name: 'koiforge_get_object', description: 'Get one business object by type and ID, with relationships, revisions and provenance.', annotations: ro,
      inputSchema: { type: 'object', required: ['object_type', 'object_id'], properties: { object_type: id, object_id: id } },
      handler: async (a) => (await http('GET', `/api/objects/${seg(a.object_type, 'object_type')}/${seg(a.object_id, 'object_id')}`)).data },
    { name: 'koiforge_list_missions', description: 'List missions (business questions checked against data).', annotations: ro,
      inputSchema: { type: 'object', properties: {} }, handler: get('/api/missions') },
    { name: 'koiforge_get_mission', description: 'Get a mission with plan, revision, results and evidence.', annotations: ro,
      inputSchema: { type: 'object', required: ['mission_id'], properties: { mission_id: id } },
      handler: async (a) => (await http('GET', `/api/missions/${seg(a.mission_id, 'mission_id')}`)).data },
    { name: 'koiforge_list_cases', description: 'List clarification cases created from findings.', annotations: ro,
      inputSchema: { type: 'object', properties: {} }, handler: get('/api/cases') },
    { name: 'koiforge_get_case', description: 'Get one case with history.', annotations: ro,
      inputSchema: { type: 'object', required: ['case_id'], properties: { case_id: id } },
      handler: async (a) => (await http('GET', `/api/cases/${seg(a.case_id, 'case_id')}`)).data },
    { name: 'koiforge_list_routines', description: 'List saved routines (repeatable checks).', annotations: ro,
      inputSchema: { type: 'object', properties: {} }, handler: get('/api/routines') },
    { name: 'koiforge_create_mission', description: 'Create a mission: a business question to check against one dataset. Planning happens server-side; nothing runs yet.',
      write: true, annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: { type: 'object', required: ['question', 'dataset_id'], properties: {
        question: { type: 'string', maxLength: 1000 }, dataset_id: id,
        relationship_id: { type: 'string', description: 'Optional semantic-model relationship to check' } } },
      handler: async (a) => (await http('POST', '/api/missions', { body: {
        question: a.question, datasetId: a.dataset_id, requestId: randomUUID(),
        ...(a.relationship_id ? { relationshipId: a.relationship_id } : {}) } })).data },
    { name: 'koiforge_run_mission', description: 'Run a planned mission at a given revision. Requires explicit human confirmation (confirmed=true).',
      write: true, annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: { type: 'object', required: ['mission_id', 'revision', 'confirmed'], properties: { mission_id: id,
        revision: { type: 'integer', minimum: 1 }, confirmed: { type: 'boolean' },
        extra: { type: 'object', description: 'Optional binding/rule/orderRule as returned by the mission plan' } } },
      handler: async (a) => {
        if (a.confirmed !== true) throw new Error('A human must confirm the run (confirmed=true)');
        return (await http('POST', `/api/missions/${seg(a.mission_id, 'mission_id')}/run`, { body: {
          ...(a.extra ?? {}), revision: a.revision, confirmed: true, requestId: randomUUID() } })).data;
      } },
  ];
  const readOnly = String(env.KOIFORGE_READ_ONLY || '').toLowerCase() === 'true';
  return tools.filter((t) => !(readOnly && t.write));
}

export function buildServer(env = process.env) {
  return createServer({
    name: 'koiforge-mcp', version: '0.1.0',
    instructions: 'KoiForge data platform. Inspect datasets and the semantic model first, create missions for business questions, and only run missions or change cases after explicit human confirmation.',
    tools: buildTools(env),
  });
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('koiforge-mcp')) {
  if (!process.env.KOIFORGE_BASE_URL) {
    process.stderr.write('koiforge-mcp: KOIFORGE_BASE_URL is required\n');
    process.exit(1);
  }
  buildServer().listen();
}

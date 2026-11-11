import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';

import { getConfig } from './config.js';
import { createRegistries } from './registries.js';
import { registerAssetsRoutes } from './routes/assets.js';
import { installAuthentication, authOrigins } from './routes/auth.js';
import { AuthStore } from './auth-store.js';
import { join, dirname } from 'node:path';
import { registerBootstrapRoutes } from './routes/bootstrap.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerCrosswalksRoutes } from './routes/crosswalks.js';
import { registerDatasetsRoutes } from './routes/datasets.js';
import { registerDiscoveryRoutes } from './routes/discovery.js';
import { registerHealthRoute } from './routes/health.js';
import { registerModulesRoutes } from './routes/modules.js';
import { registerObjectsRoutes } from './routes/objects.js';
import { registerOntologyRoutes } from './routes/ontology.js';
import { registerSecurityRoutes } from './routes/security.js';
import { registerIngestRoutes } from './routes/ingest.js';
import { registerActionsRoutes } from './routes/actions.js';
import { registerAipRoutes } from './routes/aip.js';
import { registerAppStoreRoutes } from './routes/appstore.js';
import { registerChecksRoutes } from './routes/checks.js';
import { registerPipelinesRoutes } from './routes/pipelines.js';
import { registerViewsRoutes } from './routes/views.js';
import { registerMonitoringRoutes } from './routes/monitoring.js';
import { createPrometheusMonitoringQueryService } from './monitoring/prometheus.js';
import { createGitLabQueueService } from './monitoring/gitlab-queue.js';
import { registerGitLabQueueRoutes } from './routes/gitlab-queue.js';
import { getImportSessionDataRoot, registerImportSessionRoutes } from './routes/import-sessions.js';
import { registerFreshnessRoutes } from './routes/freshness.js';
import { createFreshnessService } from './analysis/freshness-service.js';
import { createMissionEngine } from './missions/engine.js';
import { createMissionService, type MissionService } from './missions/service.js';
import { registerMissionRoutes } from './routes/missions.js';
import { registerRoutineRoutes } from './routes/routines.js';
import { registerCaseRoutes } from './routes/cases.js';
import { createCaseService } from './cases/service.js';
import { createSemanticModelService } from './semantic-model/service.js';
import { registerSemanticModelRoutes } from './routes/semantic-model.js';
import { createObjectWorkspaceService } from './object-workspace/service.js';
import { registerObjectWorkspaceRoutes } from './routes/object-workspace.js';
import { createProjectService } from './projects/service.js';
import { registerProjectRoutes } from './routes/projects.js';
import { createDataflowService } from './dataflows/service.js';
import { registerDataflowRoutes } from './routes/dataflows.js';
import { acquireStateLease, canonicalStateRoot, type StateLease } from './operations/state-lease.js';

export async function buildServer() {
  const config = getConfig();
  const [registryRoot, analysisRoot, capturedImportRoot] = await Promise.all([
    canonicalStateRoot(dirname(config.securityRegistryFilePath)),
    canonicalStateRoot(process.env.KOIFORGE_IMPORT_DATA_ROOT ?? join(process.cwd(), '.koiforge')),
    canonicalStateRoot(getImportSessionDataRoot()),
  ]);
  if (capturedImportRoot !== analysisRoot) {
    throw new Error('Der Import-Datenordner wurde nach dem Laden des Servers geändert. Bitte den Prozess mit unveränderter Konfiguration neu starten.');
  }
  const leases: StateLease[] = [];
  let app: FastifyInstance | undefined;
  let missions: MissionService | undefined;
  let shutdown: Promise<void> | undefined;
  const finish = () => shutdown ??= (async () => {
    const failures: unknown[] = [];
    if (missions) {
      try { await missions.close(); } catch (error) { failures.push(error); }
      // close blocks result publication but an engine may still write frozen
      // sources or analysis artifacts. Keep the leases until it has settled.
      try { await missions.whenIdle(); } catch (error) { failures.push(error); }
    }
    for (const lease of [...leases].reverse()) {
      try { await lease.release(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Der Server konnte nicht vollständig beendet werden.');
  })();

  try {
    // Sorted, canonical roots avoid duplicate locks for aliases and establish
    // one acquisition order before any registry or worker can publish files.
    for (const root of [...new Set([registryRoot, analysisRoot])].sort()) {
      const lease = await acquireStateLease(root); leases.push(lease);
      if (lease.root !== root) throw new Error('Der Datenordner wurde während des Serverstarts verändert.');
    }
    const registries = createRegistries(config);

    app = Fastify({ logger: true });
    // Fastify closes hooks in reverse registration order. Register the lease
    // release first so later service/plugin hooks and HTTP draining finish first.
    app.addHook('onClose', finish);
    await app.register(cors, {
      origin: authOrigins(),
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    });
    await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } }); // 50 MB

    const authStore = new AuthStore(join(dirname(config.securityRegistryFilePath), 'auth.json'));
    installAuthentication(app, authStore, authOrigins());
    registerHealthRoute(app, config);
    registerSecurityRoutes(app, registries);
    registerConfigRoutes(app, registries);
    registerCrosswalksRoutes(app, registries);
    registerViewsRoutes(app, registries);
    registerMonitoringRoutes(app, registries, createPrometheusMonitoringQueryService(config.prometheusUrl));
    registerGitLabQueueRoutes(app, registries, createGitLabQueueService({
      token: config.gitlabQueueToken, projects: config.gitlabQueueProjects,
    }));
    registerOntologyRoutes(app, registries);
    registerDiscoveryRoutes(app, registries);
    registerAssetsRoutes(app, registries);
    registerModulesRoutes(app, registries);
    registerDatasetsRoutes(app, registries);
    await registerIngestRoutes(app, registries);
    await registerImportSessionRoutes(app, registries);
    const freshness = createFreshnessService(analysisRoot, registries);
    registerFreshnessRoutes(app, registries, freshness);
    const semanticModel = createSemanticModelService({ root: analysisRoot, registries,
      resolvePrincipal: reference => authStore.resolvePrincipal(reference),
      assertPermissions: (session, permissions) => registries.security.assertPermissions(session, permissions) });
    registerSemanticModelRoutes(app, semanticModel);
    registerDataflowRoutes(app, createDataflowService({ root: analysisRoot, semanticModel,
      resolvePrincipal: reference => authStore.resolvePrincipal(reference),
      assertPermissions: (session, permissions) => registries.security.assertPermissions(session, permissions) }));
    const projects = createProjectService({ root: analysisRoot,
      resolvePrincipal: reference => authStore.resolvePrincipal(reference),
      assertPermissions: (session, permissions) => registries.security.assertPermissions(session, permissions),
      listTeam: session => authStore.listTeam(session) });
    registerProjectRoutes(app, projects);
    registerObjectWorkspaceRoutes(app, createObjectWorkspaceService({ root: analysisRoot, projects,
      resolvePrincipal: reference => authStore.resolvePrincipal(reference),
      assertPermissions: (session, permissions) => registries.security.assertPermissions(session, permissions) }));
    missions = await createMissionService({ root: analysisRoot, semanticModel,
      engine: createMissionEngine(analysisRoot, registries, { freshness, semanticModel }),
      resolvePrincipal: reference => authStore.resolvePrincipal(reference),
      assertPermissions: (session, permissions) => registries.security.assertPermissions(session, permissions) });
    registerMissionRoutes(app, missions);
    registerRoutineRoutes(app, missions);
    registerCaseRoutes(app, createCaseService({ root: analysisRoot, semanticModel,
      resolvePrincipal: reference => authStore.resolvePrincipal(reference),
      assertPermissions: (session, permissions) => registries.security.assertPermissions(session, permissions) }));
    registerObjectsRoutes(app, registries);
    registerPipelinesRoutes(app, registries);
    registerChecksRoutes(app, registries);
    registerActionsRoutes(app, registries);
    registerAipRoutes(app, registries);
    registerAppStoreRoutes(app, registries);

    if (process.env.NODE_ENV !== 'production') {
      registerBootstrapRoutes(app, registries);
    }

    return app;
  } catch (error) {
    const failures: unknown[] = [error];
    if (app) { try { await app.close(); } catch (closeError) { failures.push(closeError); } }
    try { await finish(); } catch (closeError) { if (!failures.includes(closeError)) failures.push(closeError); }
    if (failures.length > 1) throw new AggregateError(failures, 'Der Serverstart ist fehlgeschlagen; Fehler beim Beenden.', { cause: error });
    throw error;
  }
}

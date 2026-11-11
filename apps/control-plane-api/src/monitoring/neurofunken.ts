import type { MonitoringSensorDefinition } from '../routes/monitoring.js';

// Fixed, server-owned selectors. A failed or absent scrape must not look healthy.
const healthy = (query: string, job: string) => `(${query}) and on() (min(up{job="${job}"}) == 1)`;

function memoryBudget(namespace: string): string {
  const usage = `max by(namespace,pod,container) (container_memory_working_set_bytes{job="kubelet-cadvisor",namespace="${namespace}",container!="",container!="POD"})`;
  const limits = `max by(namespace,pod,container) (kube_pod_container_resource_limits{job="kube-state-metrics",namespace="${namespace}",resource="memory"})`;
  const matched = `(${usage}) and on(namespace,pod,container) (${limits} > 0)`;
  const budget = `(${limits}) and on(namespace,pod,container) (${usage})`;
  // Denominator includes only currently observed containers. Any unbounded or
  // missing container limit makes the aggregate unknown, not artificially low.
  const ratio = `(100 * sum(${usage}) / sum(${budget})) and on() (count(${usage}) == count(${matched}))`;
  return healthy(healthy(ratio, 'kubelet-cadvisor'), 'kube-state-metrics');
}

export const neurofunkenQueries = {
  cluster_restarts: healthy('sum(increase(kube_pod_container_status_restarts_total{job="kube-state-metrics"}[1h]))', 'kube-state-metrics'),
  cluster_pressure: healthy('sum(kube_node_status_condition{job="kube-state-metrics",condition=~"MemoryPressure|DiskPressure|PIDPressure",status="true"})', 'kube-state-metrics'),
  scrape_failures: 'sum(up == bool 0)',
  certificates_not_ready: healthy('sum(certmanager_certificate_ready_status{job="cert-manager",condition="True"} == bool 0)', 'cert-manager'),
  cluster_certificate_expiry: healthy('(min(certmanager_certificate_expiration_timestamp_seconds{job="cert-manager"}) - time()) / 86400', 'cert-manager'),
  runner_jobs: healthy('sum(gitlab_runner_jobs{job="gitlab-runner"})', 'gitlab-runner'),
  runner_utilization: healthy('100 * sum(gitlab_runner_jobs{job="gitlab-runner"}) / (sum(gitlab_runner_concurrent{job="gitlab-runner"}) > 0)', 'gitlab-runner'),
  memory_koiforge: memoryBudget('koiforge'),
  memory_solveit: memoryBudget('solveit-support'),
  memory_keycloak: memoryBudget('keycloak-system'),
  memory_symphony: memoryBudget('symphony-system'),
  memory_mcp: memoryBudget('chat-control'),
};

const memorySensors = [
  ['koiforge', 'KoiForge', 'koiforge'], ['solveit', 'SolveIT', 'solveit-support'],
  ['keycloak', 'Keycloak', 'keycloak-system'], ['symphony', 'Symphony', 'symphony-system'],
  ['mcp', 'MCP & Chat-Control', 'chat-control'],
] as const;

export const neurofunkenSensors: MonitoringSensorDefinition[] = [
  { id:'kubernetes.containers.restarts', name:'Container-Neustarts / 1 h', group:'kubernetes', kind:'count', unit:'count',
    description:'Geschätzte Neustarts aktuell erfasster Container im gleitenden Stundenfenster. Gelöschte Pods sind nicht vollständig enthalten.',
    defaultWindow:'6h', queryKey:'cluster_restarts', statusRule:{mode:'max',warning:1,critical:5} },
  { id:'kubernetes.nodes.pressure', name:'Node-Ressourcendruck', group:'kubernetes', kind:'count', unit:'count',
    description:'Aktive MemoryPressure-, DiskPressure- und PIDPressure-Zustände. Mehrere Probleme je Node zählen einzeln.',
    defaultWindow:'1h', queryKey:'cluster_pressure', statusRule:{mode:'nonzero',level:'critical'} },
  { id:'monitoring.scrapes.failed', name:'Fehlgeschlagene Messabrufe', group:'monitoring', kind:'count', unit:'count',
    description:'Aktuell fehlgeschlagene Prometheus-Scrapes. Aus der Konfiguration entfernte Ziele sind nicht enthalten.',
    defaultWindow:'1h', queryKey:'scrape_failures', statusRule:{mode:'nonzero',level:'warning'} },
  { id:'tls.certificates.not-ready', name:'Zertifikate nicht bereit', group:'tls', kind:'count', unit:'count',
    description:'Von cert-manager verwaltete Zertifikate ohne Ready=True, einschließlich laufender Erneuerungen.',
    defaultWindow:'6h', queryKey:'certificates_not_ready', statusRule:{mode:'nonzero',level:'warning'} },
  { id:'tls.cluster.expiry-days', name:'Cluster-TLS Restlaufzeit', group:'tls', kind:'duration', unit:'days',
    description:'Kürzeste Restlaufzeit aller von cert-manager gemeldeten Zertifikate; getrennt von öffentlichen TLS-Prüfungen.',
    defaultWindow:'24h', queryKey:'cluster_certificate_expiry', statusRule:{mode:'min',warning:30,critical:14} },
  { id:'runner.jobs.active', name:'Aktive Runner-Jobs', group:'runner', kind:'count', unit:'count',
    description:'Jobs des überwachten NeuroFunken-Runners inklusive Vor-/Nachbereitung. Kein Fehlerindikator und nicht die projektübergreifende GitLab-Queue.',
    defaultWindow:'1h', queryKey:'runner_jobs', statusRule:{mode:'informational'} },
  { id:'runner.capacity.utilization', name:'Runner-Belegung', group:'runner', kind:'gauge', unit:'percent',
    description:'Aktive Jobs relativ zur konfigurierten Parallelität. 100 % bedeutet voll belegt, nicht festgefahren. Hinweis ab 100 %, kritisch ab 101 %.',
    defaultWindow:'1h', queryKey:'runner_utilization', statusRule:{mode:'max',warning:100,critical:101} },
  ...memorySensors.map(([id,name,namespace]): MonitoringSensorDefinition => ({
    id:`application.${id}.memory`, name:`${name} RAM-Budget`, group:'application', kind:'gauge', unit:'percent',
    description:`Working-Set-Speicher relativ zu den Limits aller beobachteten Container im Namespace ${namespace}, inklusive Begleitdiensten. Unvollständige Limits bleiben unbekannt. Kein Funktionsnachweis.`,
    defaultWindow:'6h', queryKey:`memory_${id}`, statusRule:{mode:'max',warning:75,critical:85},
  })),
];

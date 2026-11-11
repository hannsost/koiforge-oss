import type { MonitoringSensorRecord, MonitoringSensorSummary, MonitoringWindow } from '../../api';

export type DashboardViewId = 'overview' | 'infrastructure' | 'applications' | 'ci' | 'security';
interface DashboardView {
  id: DashboardViewId; label: string; kicker: string; title: string; description: string;
  sensors: string[]; charts: string[]; noteTitle: string; note: string; gap: string;
}
export const dashboardViews: DashboardView[] = [
  { id: 'overview', label: 'Überblick', kicker: '01 / Lagebild', title: 'Wie steht es um die Plattform?',
    description: 'Die wichtigsten Signale für den täglichen Check.',
    sensors: ['endpoint.https.up', 'node.cpu.utilization', 'backup.age-hours', 'alerts.active'],
    charts: ['node.cpu.utilization', 'node.memory.utilization', 'endpoint.https.up', 'alerts.active'],
    noteTitle: 'Vom Überblick ins Detail', note: 'Die Themen oben trennen Kapazität, Erreichbarkeit, Auslieferung und Absicherung. Ein grüner Einzelwert ist keine pauschale Entwarnung für die gesamte Plattform.',
    gap: 'Ein Gesamt-SLA und eine verlässliche Prognose für das Ende der CI-Warteschlange sind noch nicht verfügbar.' },
  { id: 'infrastructure', label: 'Server & Cluster', kicker: '02 / Infrastruktur', title: 'Kapazität & Cluster-Zustand',
    description: 'Ressourcen des Kubernetes-Nodes und Verfügbarkeit der Workloads.',
    sensors: ['node.cpu.utilization', 'node.memory.utilization', 'node.filesystem.free', 'kubernetes.pods.not-ready', 'kubernetes.deployments.unavailable', 'kubernetes.containers.restarts', 'kubernetes.nodes.pressure', 'monitoring.scrapes.failed'],
    charts: ['node.cpu.utilization', 'node.memory.utilization', 'node.filesystem.free', 'kubernetes.pods.not-ready', 'kubernetes.containers.restarts', 'monitoring.scrapes.failed'],
    noteTitle: 'Was diese Werte abdecken', note: 'CPU, Arbeitsspeicher und Root-Dateisystem beziehen sich auf den überwachten Kubernetes-Node. Nicht verfügbare Replikas zeigen Beeinträchtigungen der Workloads.',
    gap: 'Der separate Website-Server ist in diesen Node-Kennzahlen noch nicht enthalten. Netzwerkdurchsatz und Datenträger-Latenz werden hier noch nicht erfasst.' },
  { id: 'applications', label: 'Anwendungen', kicker: '03 / Erreichbarkeit', title: 'Sind die Anwendungen erreichbar?',
    description: 'Öffentliche Prüfziele, Aktualität der Beobachtung und Workload-Verfügbarkeit.',
    sensors: ['endpoint.https.up', 'endpoint.probe.targets', 'endpoint.probe.age-hours', 'kubernetes.deployments.unavailable', 'application.koiforge.memory', 'application.solveit.memory', 'application.keycloak.memory', 'application.symphony.memory', 'application.mcp.memory'],
    charts: ['endpoint.https.up', 'endpoint.probe.age-hours', 'application.koiforge.memory', 'application.solveit.memory', 'application.keycloak.memory', 'application.symphony.memory', 'application.mcp.memory'],
    noteTitle: 'Erreichbar ist nicht fehlerfrei', note: 'Ein erfolgreicher HTTPS-Check bestätigt nur den geprüften Endpunkt. RAM-Budgets aggregieren die beobachteten Container je Namespace einschließlich Begleitdiensten; sie ersetzen keine Einzelcontainer- oder Funktionsprüfung. Veraltete Beobachtungen sind kein Nachweis aktueller Verfügbarkeit.',
    gap: 'Antwortzeiten (p95), Request-Fehlerraten und fachliche Funktionsprüfungen stehen noch nicht als Messreihen bereit.' },
  { id: 'ci', label: 'GitLab & CI', kicker: '04 / Auslieferung', title: 'Warteschlange & Auslieferung',
    description: 'Offene GitLab-Jobs im Kontext des aktuellen Deployment-Zustands.',
    sensors: ['runner.jobs.active', 'runner.capacity.utilization', 'flux.reconciliation.failed', 'kubernetes.deployments.unavailable', 'alerts.active'],
    charts: ['runner.jobs.active', 'runner.capacity.utilization', 'flux.reconciliation.failed', 'kubernetes.deployments.unavailable'],
    noteTitle: 'Warten bedeutet nicht hängen', note: 'Die Warteschlange trennt laufende Jobs, Runner-Wartezeit und Folgeschritte. Flux beobachtet die GitOps-Auslieferung, nicht die Ausführung von GitLab-Jobs. Dieses Dashboard verändert keine Jobs.',
    gap: 'Historische Queue-Länge, Pipeline-Erfolgsquote und eine belastbare Restdauer werden noch nicht aufgezeichnet.' },
  { id: 'security', label: 'Backups & Sicherheit', kicker: '05 / Absicherung', title: 'Backups & Zertifikate',
    description: 'Bestätigte Sicherungen und Restlaufzeit der überwachten TLS-Zertifikate.',
    sensors: ['backup.age-hours', 'tls.cert.expiry-days', 'tls.cluster.expiry-days', 'tls.certificates.not-ready', 'endpoint.probe.age-hours'],
    charts: ['backup.age-hours', 'tls.cert.expiry-days', 'tls.cluster.expiry-days', 'tls.certificates.not-ready'],
    noteTitle: 'Ein Backup ist noch kein Restore-Test', note: 'Das Backup-Alter basiert auf dem zuletzt gemeldeten Erfolg. Es bestätigt weder die Vollständigkeit aller Sicherungen noch deren Wiederherstellbarkeit. TLS zeigt die kürzeste beobachtete Restlaufzeit.',
    gap: 'Restore-Test-Ergebnisse, Sicherungsabdeckung pro Dienst und Security-Scan-Ergebnisse sind noch nicht angebunden.' },
];

export const sensorLabels: Record<string, string> = {
  'node.cpu.utilization': 'CPU-Auslastung', 'node.memory.utilization': 'Arbeitsspeicher',
  'node.filesystem.free': 'Freier Speicher', 'kubernetes.pods.not-ready': 'Pods nicht bereit',
  'kubernetes.deployments.unavailable': 'Nicht verfügbare Replikas', 'flux.reconciliation.failed': 'Flux-Fehler',
  'tls.cert.expiry-days': 'TLS-Restlaufzeit', 'backup.age-hours': 'Letztes Backup vor',
  'endpoint.https.up': 'HTTPS-Erreichbarkeit', 'endpoint.probe.age-hours': 'Älteste externe Prüfung',
  'endpoint.probe.targets': 'Gemeldete Prüfserien', 'alerts.active': 'Aktive Alarme',
  'kubernetes.containers.restarts': 'Container-Neustarts / 1 h', 'kubernetes.nodes.pressure': 'Node-Ressourcendruck',
  'monitoring.scrapes.failed': 'Fehlgeschlagene Messabrufe', 'tls.certificates.not-ready': 'Zertifikate nicht bereit',
  'tls.cluster.expiry-days': 'Cluster-TLS Restlaufzeit', 'runner.jobs.active': 'Aktive Runner-Jobs',
  'runner.capacity.utilization': 'Runner-Belegung', 'application.koiforge.memory': 'KoiForge RAM-Budget',
  'application.solveit.memory': 'SolveIT RAM-Budget', 'application.keycloak.memory': 'Keycloak RAM-Budget',
  'application.symphony.memory': 'Symphony RAM-Budget', 'application.mcp.memory': 'MCP & Chat-Control RAM-Budget',
};
export const stateLabels = { ok: 'OK', warning: 'Warnung', critical: 'Kritisch', unknown: 'Unbekannt' };

export function readDashboardLocation() {
  const params = new URLSearchParams(window.location.hash.split('?')[1]);
  const view = params.get('view');
  const range = params.get('range');
  return { view: (dashboardViews.some(item => item.id === view) ? view : 'overview') as DashboardViewId,
    range: (['15m', '1h', '6h', '24h', '7d'].includes(range ?? '') ? range : '6h') as MonitoringWindow };
}

export function formatMonitoringValue(value: number | null | undefined, sensor?: Pick<MonitoringSensorRecord, 'id' | 'unit'>): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (sensor?.id === 'flux.reconciliation.failed') return Math.round(value).toLocaleString('de-DE');
  const number = (n: number, digits = 1) => n.toLocaleString('de-DE', { maximumFractionDigits: digits });
  switch (sensor?.unit) {
    case 'percent': return `${number(value)} %`;
    case 'bytes': return value >= 1024 ** 3 ? `${number(value / 1024 ** 3)} GiB` : `${number(value / 1024 ** 2)} MiB`;
    case 'days': return `${number(value)} Tage`;
    case 'hours': return value < 1 ? `${number(value * 60, 0)} Min.` : `${number(value)} Std.`;
    case 'boolean': return value >= 1 ? 'Erreichbar' : 'Nicht erreichbar';
    case 'count': return number(value, 0);
    default: return number(value, 2);
  }
}

export function visibleSensorState(sensor: MonitoringSensorSummary | undefined, unavailable: boolean) {
  return unavailable || !sensor || sensor.value == null || !Number.isFinite(sensor.value) ? 'unknown' : sensor.state;
}

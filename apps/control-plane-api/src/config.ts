import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export interface AppConfig {
  host: string;
  port: number;
  assetLineageFilePath: string;
  coreVersion: string;
  configRegistryFilePath: string;
  moduleRegistryFilePath: string;
  datasetRegistryFilePath: string;
  pipelineRegistryFilePath: string;
  checksRegistryFilePath: string;
  aipRegistryFilePath: string;
  savedViewsFilePath: string;
  securityRegistryFilePath: string;
  seededContracts: string[];
  prometheusUrl?: string;
  gitlabQueueToken?: string;
  gitlabQueueProjects?: string;
}

export function getConfig(): AppConfig {
  const statePath = (name: string) => process.env.KOIFORGE_STATE_ROOT
    ? resolve(process.env.KOIFORGE_STATE_ROOT, name)
    : fileURLToPath(new URL(`../data/${name}`, import.meta.url));
  const seededContracts = (process.env.KOIFORGE_SEEDED_CONTRACTS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  return {
    host: process.env.HOST ?? '0.0.0.0',
    port: Number.parseInt(process.env.PORT ?? '3000', 10),
    assetLineageFilePath: statePath('asset-lineage.json'),
    coreVersion: process.env.KOIFORGE_CORE_VERSION ?? '0.1.0',
    configRegistryFilePath: statePath('config-registry.json'),
    moduleRegistryFilePath: statePath('module-registry.json'),
    datasetRegistryFilePath: statePath('dataset-registry.json'),
    pipelineRegistryFilePath: statePath('pipeline-registry.json'),
    checksRegistryFilePath: statePath('checks-registry.json'),
    aipRegistryFilePath: statePath('aip-registry.json'),
    savedViewsFilePath: statePath('saved-views.json'),
    securityRegistryFilePath: statePath('security-registry.json'),
    seededContracts,
    prometheusUrl: process.env.KOIFORGE_PROMETHEUS_URL?.trim() || undefined,
    gitlabQueueToken: process.env.KOIFORGE_GITLAB_QUEUE_TOKEN?.trim() || undefined,
    gitlabQueueProjects: process.env.KOIFORGE_GITLAB_QUEUE_PROJECTS?.trim() || undefined,
  };
}

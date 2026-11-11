import { FileAipRegistry } from '@koiforge/aip-core';
import { FileAssetLineageRegistry } from '@koiforge/asset-lineage-core';
import { FileChecksRegistry } from '@koiforge/checks-core';
import { FileConfigRegistry } from '@koiforge/config-core';
import { FileDatasetRegistry } from '@koiforge/data-registry';
import { FileModuleRegistry } from '@koiforge/module-system';
import { FilePipelineRegistry } from '@koiforge/pipeline-core';
import { FileSavedViewRegistry } from '@koiforge/saved-view-core';
import { FileSecurityRegistry } from '@koiforge/security-core';

import type { AppConfig } from './config.js';

export interface AppRegistries {
  aip: FileAipRegistry;
  assetLineage: FileAssetLineageRegistry;
  checks: FileChecksRegistry;
  config: FileConfigRegistry;
  module: FileModuleRegistry;
  dataset: FileDatasetRegistry;
  pipeline: FilePipelineRegistry;
  savedView: FileSavedViewRegistry;
  security: FileSecurityRegistry;
}

export function createRegistries(config: AppConfig): AppRegistries {
  return {
    aip: new FileAipRegistry({ filePath: config.aipRegistryFilePath }),
    assetLineage: new FileAssetLineageRegistry({ filePath: config.assetLineageFilePath }),
    checks: new FileChecksRegistry({ filePath: config.checksRegistryFilePath }),
    config: new FileConfigRegistry({ filePath: config.configRegistryFilePath }),
    module: new FileModuleRegistry({
      filePath: config.moduleRegistryFilePath,
      coreVersion: config.coreVersion,
      seededContracts: config.seededContracts,
    }),
    dataset: new FileDatasetRegistry({ filePath: config.datasetRegistryFilePath }),
    pipeline: new FilePipelineRegistry({ filePath: config.pipelineRegistryFilePath }),
    savedView: new FileSavedViewRegistry({ filePath: config.savedViewsFilePath }),
    security: new FileSecurityRegistry({ filePath: config.securityRegistryFilePath }),
  };
}

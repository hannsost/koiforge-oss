import type { ModuleManifest, UiContribution } from '@koiforge/module-manifest';
import type { OntologyValidationResult } from '@koiforge/ontology-core';

export type ModuleStatus = 'installed' | 'enabled' | 'disabled';
export type ModuleLifecycleEventType = 'install' | 'upgrade' | 'enable' | 'disable' | 'rollback';

export interface InstalledModuleVersion {
  version: string;
  manifest: ModuleManifest;
  installedAt: string;
  source?: string;
}

export interface ModuleRecord {
  id: string;
  status: ModuleStatus;
  currentVersion: string;
  versions: InstalledModuleVersion[];
  updatedAt: string;
}

export interface ModuleAuditEvent {
  type: ModuleLifecycleEventType;
  moduleId: string;
  version: string;
  timestamp: string;
  details?: string;
}

export interface RegistryState {
  coreVersion: string;
  modules: Record<string, ModuleRecord>;
  audit: ModuleAuditEvent[];
}

export interface CompatibilityIssue {
  kind: 'core-version' | 'ontology-contract';
  requirement: string;
  message: string;
  available?: string[];
}

export interface CompatibilityResult {
  ok: boolean;
  issues: CompatibilityIssue[];
  availableContracts: string[];
}

export interface LifecycleOperationResult {
  module: ModuleRecord;
  event: ModuleAuditEvent;
  compatibility?: CompatibilityResult;
  ontologyValidation?: OntologyValidationResult;
}

export interface CapabilityRegistration {
  capability: string;
  moduleId: string;
  version: string;
}

export interface UiSlotRegistration extends UiContribution {
  moduleId: string;
  version: string;
}

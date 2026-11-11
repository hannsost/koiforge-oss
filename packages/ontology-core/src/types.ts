import type { ModuleManifest, PropertyDefinition } from '@koiforge/module-manifest';

export type OntologyConflictKind =
  | 'reserved-object'
  | 'duplicate-object-contract'
  | 'missing-base-object'
  | 'property-type-conflict'
  | 'namespace-conflict'
  | 'action-signature-conflict';

export interface OntologyProperty {
  name: string;
  type: PropertyDefinition['type'];
  required: boolean;
  computed: boolean;
  contributors: string[];
}

export interface OntologyObjectContract {
  key: string;
  name: string;
  namespace: string;
  contractVersion: number;
  contributors: string[];
  properties: OntologyProperty[];
  extensionContributors: string[];
}

export interface OntologyActionContract {
  key: string;
  name: string;
  contractVersion: number;
  input: string;
  permissions: string[];
  contributors: string[];
}

export interface OntologySnapshot {
  modules: string[];
  objects: OntologyObjectContract[];
  actions: OntologyActionContract[];
  extensions: number;
}

export interface OntologyConflict {
  kind: OntologyConflictKind;
  severity: 'error' | 'warning';
  moduleId: string;
  message: string;
  subject: string;
}

export interface OntologyValidationResult {
  ok: boolean;
  snapshot: OntologySnapshot;
  conflicts: OntologyConflict[];
}

export interface OntologySourceModule {
  moduleId: string;
  manifest: ModuleManifest;
}


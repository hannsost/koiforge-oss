export type TrustLevel = 'native' | 'sandboxed' | 'declarative';

export type PropertyType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'object'
  | 'array';

export interface PropertyDefinition {
  name: string;
  type: PropertyType;
  required?: boolean;
  computed?: boolean;
}

export interface ObjectContribution {
  name: string;
  'contract-version': number;
  namespace: string;
  properties?: PropertyDefinition[];
}

export interface ExtensionContribution {
  object: string;
  properties?: PropertyDefinition[];
}

export interface ActionContribution {
  name: string;
  'contract-version': number;
  input: string;
  permissions: string[];
  'side-effects'?: string[];
  compensation?: string;
}

export interface UiContribution {
  slot: string;
  component: string;
  lazy?: boolean;
}

export interface PolicyContribution {
  type: 'row-level' | 'column-level' | 'object-level' | 'action-level';
  condition: string;
}

export interface MigrationDefinition {
  from: string;
  strategy: 'additive' | 'breaking' | 'rollback';
}

export interface ModuleManifest {
  id: string;
  version: string;
  name?: string;
  description?: string;
  'trust-level': TrustLevel;
  requires: {
    core: string;
    'ontology-contracts'?: string[];
  };
  capabilities?: string[];
  contributes: {
    objects?: ObjectContribution[];
    extends?: ExtensionContribution[];
    actions?: ActionContribution[];
    ui?: UiContribution[];
    policies?: PolicyContribution[];
  };
  migrations: MigrationDefinition[];
  'compatibility-tests'?: string[];
}

export interface ManifestValidationIssue {
  code: string;
  path: string;
  message: string;
}

export interface ManifestValidationResult {
  valid: boolean;
  source: string;
  manifest?: ModuleManifest;
  errors: ManifestValidationIssue[];
  warnings: string[];
}


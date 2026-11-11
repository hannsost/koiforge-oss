export type ConfigScope = 'global' | 'tenant';
export type ConfigValueType = 'string' | 'number' | 'boolean' | 'json' | 'secret-ref';

export interface SecretRecord {
  id: string;
  name: string;
  scope: ConfigScope;
  tenantId?: string;
  description?: string;
  tags: string[];
  value: string;
  createdAt: string;
  updatedAt: string;
}

export interface SecretMetadata {
  id: string;
  name: string;
  scope: ConfigScope;
  tenantId?: string;
  description?: string;
  tags: string[];
  maskedValue: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConfigEntryRecord {
  id: string;
  key: string;
  scope: ConfigScope;
  tenantId?: string;
  valueType: ConfigValueType;
  value: string | number | boolean | Record<string, unknown> | string[];
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResolvedConfigEntry {
  key: string;
  scope: ConfigScope;
  tenantId?: string;
  valueType: ConfigValueType;
  resolvedValue: string | number | boolean | Record<string, unknown> | string[];
  description?: string;
  source: 'literal' | 'secret';
}

export interface ConfigState {
  secrets: SecretRecord[];
  entries: ConfigEntryRecord[];
}

export interface SecretUpsertInput {
  name: string;
  scope?: ConfigScope;
  tenantId?: string;
  description?: string;
  tags?: string[];
  value: string;
}

export interface ConfigEntryUpsertInput {
  key: string;
  scope?: ConfigScope;
  tenantId?: string;
  valueType: ConfigValueType;
  value: string | number | boolean | Record<string, unknown> | string[];
  description?: string;
}

export interface FileConfigRegistryOptions {
  filePath: string;
}


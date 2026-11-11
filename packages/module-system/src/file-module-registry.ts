import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  collectDeclaredContracts,
  formatValidationErrors,
  parseContractReference,
  validateManifestDocument,
  validateManifestText,
} from '@koiforge/module-manifest';
import type { ModuleManifest } from '@koiforge/module-manifest';
import { validateManifestMerge } from '@koiforge/ontology-core';
import type { OntologySourceModule } from '@koiforge/ontology-core';
import semver from 'semver';

import type {
  CapabilityRegistration,
  CompatibilityIssue,
  CompatibilityResult,
  InstalledModuleVersion,
  LifecycleOperationResult,
  ModuleAuditEvent,
  ModuleRecord,
  RegistryState,
  UiSlotRegistration,
} from './types.js';

export interface FileModuleRegistryOptions {
  filePath: string;
  coreVersion?: string;
  seededContracts?: string[];
}

function createEmptyState(coreVersion: string): RegistryState {
  return {
    coreVersion,
    modules: {},
    audit: [],
  };
}

function normalizeVersion(value: string): string {
  if (/^\d+$/.test(value)) {
    return `${value}.0.0`;
  }

  if (/^\d+\.\d+$/.test(value)) {
    return `${value}.0`;
  }

  return value;
}

function parseContractEntry(value: string): { name: string; version: string } | null {
  const atIndex = value.lastIndexOf('@');

  if (atIndex <= 0 || atIndex === value.length - 1) {
    return null;
  }

  const name = value.slice(0, atIndex);
  const version = normalizeVersion(value.slice(atIndex + 1));

  if (!semver.valid(version)) {
    return null;
  }

  return { name, version };
}

function currentVersion(record: ModuleRecord): InstalledModuleVersion {
  const active = record.versions.find((entry) => entry.version === record.currentVersion);

  if (!active) {
    throw new Error(`Aktive Version für Modul '${record.id}' konnte nicht gefunden werden.`);
  }

  return active;
}

function recordSorter(left: ModuleRecord, right: ModuleRecord): number {
  return left.id.localeCompare(right.id);
}

export class FileModuleRegistry {
  readonly #filePath: string;
  readonly #coreVersion: string;
  readonly #seededContracts: string[];

  constructor(options: FileModuleRegistryOptions) {
    this.#filePath = options.filePath;
    this.#coreVersion = options.coreVersion ?? '0.1.0';
    this.#seededContracts = (options.seededContracts ?? []).map((entry) => {
      const parsed = parseContractEntry(entry);
      return parsed ? `${parsed.name}@${parsed.version}` : entry;
    });
  }

  async #readState(): Promise<RegistryState> {
    await mkdir(dirname(this.#filePath), { recursive: true });

    try {
      const contents = await readFile(this.#filePath, 'utf8');
      return JSON.parse(contents) as RegistryState;
    } catch {
      const state = createEmptyState(this.#coreVersion);
      await this.#writeState(state);
      return state;
    }
  }

  async #writeState(state: RegistryState): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true });
    await writeFile(this.#filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  #collectAvailableContracts(state: RegistryState): string[] {
    const discovered = new Set<string>(this.#seededContracts);

    for (const record of Object.values(state.modules)) {
      const manifest = currentVersion(record).manifest;
      for (const contract of collectDeclaredContracts(manifest)) {
        discovered.add(contract);
      }
    }

    return [...discovered].sort();
  }

  #evaluateCompatibility(manifest: ModuleManifest, state: RegistryState): CompatibilityResult {
    const issues: CompatibilityIssue[] = [];
    const availableContracts = this.#collectAvailableContracts(state);
    const coreRange = normalizeVersion(manifest.requires.core);

    if (!semver.satisfies(state.coreVersion, coreRange)) {
      issues.push({
        kind: 'core-version',
        requirement: manifest.requires.core,
        message: `Core-Version ${state.coreVersion} erfüllt '${manifest.requires.core}' nicht.`,
      });
    }

    for (const requirement of manifest.requires['ontology-contracts'] ?? []) {
      const reference = parseContractReference(requirement);

      if (!reference) {
        issues.push({
          kind: 'ontology-contract',
          requirement,
          message: `Ontology-Vertrag '${requirement}' ist ungültig.`,
          available: availableContracts,
        });
        continue;
      }

      const matches = availableContracts
        .map((entry) => parseContractEntry(entry))
        .filter((entry): entry is { name: string; version: string } => Boolean(entry))
        .filter((entry) => entry.name === reference.name)
        .some((entry) => semver.satisfies(entry.version, reference.range));

      if (!matches) {
        issues.push({
          kind: 'ontology-contract',
          requirement,
          message: `Für '${requirement}' wurde kein kompatibler Vertrag gefunden.`,
          available: availableContracts,
        });
      }
    }

    return {
      ok: issues.length === 0,
      issues,
      availableContracts,
    };
  }

  #createEvent(type: ModuleAuditEvent['type'], moduleId: string, version: string, details?: string): ModuleAuditEvent {
    return {
      type,
      moduleId,
      version,
      timestamp: new Date().toISOString(),
      details,
    };
  }

  #ensureValidatedManifest(document: unknown, source: string): ModuleManifest {
    const validation = validateManifestDocument(document, source);

    if (!validation.valid || !validation.manifest) {
      throw new Error(formatValidationErrors(validation));
    }

    return validation.manifest;
  }

  async getState(): Promise<RegistryState> {
    return this.#readState();
  }

  async listModules(): Promise<ModuleRecord[]> {
    const state = await this.#readState();
    return Object.values(state.modules).sort(recordSorter);
  }

  async getModule(moduleId: string): Promise<ModuleRecord | null> {
    const state = await this.#readState();
    return state.modules[moduleId] ?? null;
  }

  async getAuditTrail(limit = 50): Promise<ModuleAuditEvent[]> {
    const state = await this.#readState();
    return state.audit.slice(0, limit);
  }

  async listCapabilities(): Promise<CapabilityRegistration[]> {
    const modules = await this.listModules();

    return modules
      .filter((record) => record.status === 'enabled')
      .flatMap((record) => {
        const manifest = currentVersion(record).manifest;
        return (manifest.capabilities ?? []).map((capability) => ({
          capability,
          moduleId: record.id,
          version: record.currentVersion,
        }));
      })
      .sort((left, right) => left.capability.localeCompare(right.capability));
  }

  async listUiContributions(): Promise<UiSlotRegistration[]> {
    const modules = await this.listModules();

    return modules
      .filter((record) => record.status === 'enabled')
      .flatMap((record) => {
        const manifest = currentVersion(record).manifest;
        return (manifest.contributes.ui ?? []).map((entry) => ({
          ...entry,
          moduleId: record.id,
          version: record.currentVersion,
        }));
      })
      .sort((left, right) => left.slot.localeCompare(right.slot));
  }

  async listCurrentManifests(): Promise<OntologySourceModule[]> {
    const modules = await this.listModules();

    return modules.map((record) => ({
      moduleId: record.id,
      manifest: currentVersion(record).manifest,
    }));
  }

  async installDocument(document: unknown, source = 'inline'): Promise<LifecycleOperationResult> {
    const manifest = this.#ensureValidatedManifest(document, source);
    const state = await this.#readState();
    const compatibility = this.#evaluateCompatibility(manifest, state);

    if (!compatibility.ok) {
      throw new Error(compatibility.issues.map((entry) => entry.message).join('\n'));
    }

    const currentManifests: OntologySourceModule[] = Object.values(state.modules)
      .filter((record) => record.id !== manifest.id)
      .map((record) => ({
      moduleId: record.id,
      manifest: currentVersion(record).manifest,
      }));
    const ontologyValidation = validateManifestMerge(currentManifests, {
      moduleId: manifest.id,
      manifest,
    });

    if (!ontologyValidation.ok) {
      throw new Error(ontologyValidation.conflicts.map((entry) => entry.message).join('\n'));
    }

    const existing = state.modules[manifest.id];
    if (existing?.versions.some((entry) => entry.version === manifest.version)) {
      throw new Error(`Modul '${manifest.id}' in Version ${manifest.version} ist bereits installiert.`);
    }

    const now = new Date().toISOString();
    const nextRecord: ModuleRecord = {
      id: manifest.id,
      status: existing?.status ?? 'installed',
      currentVersion: manifest.version,
      updatedAt: now,
      versions: [...(existing?.versions ?? []), { version: manifest.version, manifest, installedAt: now, source }].sort(
        (left, right) => semver.rcompare(left.version, right.version),
      ),
    };

    state.modules[manifest.id] = nextRecord;

    const event = this.#createEvent(existing ? 'upgrade' : 'install', manifest.id, manifest.version, source);
    state.audit.unshift(event);

    await this.#writeState(state);

    return {
      module: nextRecord,
      event,
      compatibility,
      ontologyValidation,
    };
  }

  async installRawText(text: string, source = 'inline'): Promise<LifecycleOperationResult> {
    const validation = validateManifestText(text, source);

    if (!validation.valid || !validation.manifest) {
      throw new Error(formatValidationErrors(validation));
    }

    return this.installDocument(validation.manifest, source);
  }

  async installFromFile(filePath: string): Promise<LifecycleOperationResult> {
    const contents = await readFile(filePath, 'utf8');
    return this.installRawText(contents, filePath);
  }

  async enableModule(moduleId: string): Promise<LifecycleOperationResult> {
    const state = await this.#readState();
    const record = state.modules[moduleId];

    if (!record) {
      throw new Error(`Modul '${moduleId}' wurde nicht gefunden.`);
    }

    record.status = 'enabled';
    record.updatedAt = new Date().toISOString();

    const event = this.#createEvent('enable', moduleId, record.currentVersion);
    state.audit.unshift(event);
    await this.#writeState(state);

    return { module: record, event };
  }

  async disableModule(moduleId: string): Promise<LifecycleOperationResult> {
    const state = await this.#readState();
    const record = state.modules[moduleId];

    if (!record) {
      throw new Error(`Modul '${moduleId}' wurde nicht gefunden.`);
    }

    record.status = 'disabled';
    record.updatedAt = new Date().toISOString();

    const event = this.#createEvent('disable', moduleId, record.currentVersion);
    state.audit.unshift(event);
    await this.#writeState(state);

    return { module: record, event };
  }

  async rollbackModule(moduleId: string, targetVersion?: string): Promise<LifecycleOperationResult> {
    const state = await this.#readState();
    const record = state.modules[moduleId];

    if (!record) {
      throw new Error(`Modul '${moduleId}' wurde nicht gefunden.`);
    }

    const availableVersions = [...record.versions].sort((left, right) => semver.rcompare(left.version, right.version));
    const target = targetVersion
      ? availableVersions.find((entry) => entry.version === targetVersion)
      : availableVersions.find((entry) => entry.version !== record.currentVersion);

    if (!target) {
      throw new Error(`Für Modul '${moduleId}' ist keine Rollback-Zielversion verfügbar.`);
    }

    record.currentVersion = target.version;
    record.updatedAt = new Date().toISOString();

    const event = this.#createEvent('rollback', moduleId, target.version);
    state.audit.unshift(event);
    await this.#writeState(state);

    return { module: record, event };
  }
}

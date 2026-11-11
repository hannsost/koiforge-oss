import * as AjvImport from 'ajv';
import * as AjvFormatsImport from 'ajv-formats';
import semver from 'semver';
import YAML from 'yaml';

import { moduleSchema } from './schema.js';
import type {
  ManifestValidationIssue,
  ManifestValidationResult,
  ModuleManifest,
  ObjectContribution,
  PropertyDefinition,
} from './types.js';

const Ajv = AjvImport.Ajv;
const addFormats = (('default' in AjvFormatsImport ? AjvFormatsImport.default : AjvFormatsImport) as unknown) as (
  ajv: InstanceType<typeof Ajv>,
) => void;

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const validateWithSchema = ajv.compile(moduleSchema);

function toIssue(code: string, path: string, message: string): ManifestValidationIssue {
  return { code, path, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeContractVersion(version: string | number): string {
  if (typeof version === 'number') {
    return `${version}.0.0`;
  }

  if (/^\d+$/.test(version)) {
    return `${version}.0.0`;
  }

  if (/^\d+\.\d+$/.test(version)) {
    return `${version}.0`;
  }

  return version;
}

export function parseContractReference(input: string): { name: string; range: string } | null {
  const atIndex = input.lastIndexOf('@');

  if (atIndex <= 0 || atIndex === input.length - 1) {
    return null;
  }

  const name = input.slice(0, atIndex);
  const range = input.slice(atIndex + 1);
  const normalizedRange = normalizeContractVersion(range);

  if (!semver.validRange(normalizedRange)) {
    return null;
  }

  return { name, range: normalizedRange };
}

function validatePropertyNames(
  properties: PropertyDefinition[] | undefined,
  path: string,
  errors: ManifestValidationIssue[],
): void {
  if (!properties || properties.length === 0) {
    return;
  }

  const seen = new Set<string>();

  for (const property of properties) {
    if (seen.has(property.name)) {
      errors.push(toIssue('duplicate-property', path, `Property '${property.name}' ist mehrfach definiert.`));
      continue;
    }

    seen.add(property.name);
  }
}

function validateObjects(
  objects: ObjectContribution[] | undefined,
  errors: ManifestValidationIssue[],
): void {
  if (!objects || objects.length === 0) {
    return;
  }

  const seen = new Set<string>();

  for (const object of objects) {
    const key = `${object.namespace}:${object.name}@${object['contract-version']}`;

    if (seen.has(key)) {
      errors.push(
        toIssue('duplicate-object', '/contributes/objects', `Objekt '${key}' ist mehrfach definiert.`),
      );
      continue;
    }

    seen.add(key);
    validatePropertyNames(
      object.properties,
      `/contributes/objects/${object.namespace}:${object.name}`,
      errors,
    );
  }
}

export function collectDeclaredContracts(manifest: ModuleManifest): string[] {
  return (manifest.contributes.objects ?? []).map(
    (entry) => `${entry.name}@${normalizeContractVersion(entry['contract-version'])}`,
  );
}

export function parseManifestText(text: string): unknown {
  return YAML.parse(text);
}

export function validateManifestDocument(
  document: unknown,
  source = 'inline',
): ManifestValidationResult {
  const errors: ManifestValidationIssue[] = [];
  const warnings: string[] = [];

  if (!isRecord(document)) {
    return {
      valid: false,
      source,
      errors: [toIssue('invalid-root', '/', 'Das Manifest muss ein Objekt sein.')],
      warnings,
    };
  }

  const validSchema = validateWithSchema(document);

  if (!validSchema) {
    for (const error of validateWithSchema.errors ?? []) {
      errors.push(
        toIssue(
          error.keyword,
          error.instancePath || '/',
          error.message ?? 'Ungültiges Manifest.',
        ),
      );
    }
  }

  const manifest = document as unknown as ModuleManifest;

  if (!semver.valid(manifest.version)) {
    errors.push(toIssue('invalid-semver', '/version', `Version '${manifest.version}' ist kein gültiges SemVer.`));
  }

  const coreRange = normalizeContractVersion(manifest.requires.core);
  if (!semver.validRange(coreRange)) {
    errors.push(
      toIssue('invalid-core-range', '/requires/core', `Core-Range '${manifest.requires.core}' ist ungültig.`),
    );
  }

  for (const requirement of manifest.requires['ontology-contracts'] ?? []) {
    if (!parseContractReference(requirement)) {
      errors.push(
        toIssue(
          'invalid-contract-reference',
          '/requires/ontology-contracts',
          `Ontology-Vertrag '${requirement}' ist ungültig.`,
        ),
      );
    }
  }

  for (const extension of manifest.contributes.extends ?? []) {
    if (!parseContractReference(extension.object)) {
      errors.push(
        toIssue(
          'invalid-extension-reference',
          '/contributes/extends',
          `Extension-Referenz '${extension.object}' ist ungültig.`,
        ),
      );
    }

    validatePropertyNames(extension.properties, `/contributes/extends/${extension.object}`, errors);
  }

  for (const action of manifest.contributes.actions ?? []) {
    if (!parseContractReference(action.input)) {
      errors.push(
        toIssue(
          'invalid-action-input',
          '/contributes/actions',
          `Action-Input '${action.input}' ist keine gültige Contract-Referenz.`,
        ),
      );
    }
  }

  validateObjects(manifest.contributes.objects, errors);

  const actionKeys = new Set<string>();
  for (const action of manifest.contributes.actions ?? []) {
    const key = `${action.name}@${action['contract-version']}`;
    if (actionKeys.has(key)) {
      errors.push(
        toIssue('duplicate-action', '/contributes/actions', `Action '${key}' ist mehrfach definiert.`),
      );
      continue;
    }

    actionKeys.add(key);
  }

  for (const migration of manifest.migrations) {
    if (!semver.valid(migration.from)) {
      errors.push(
        toIssue('invalid-migration-version', '/migrations', `Migration '${migration.from}' ist kein gültiges SemVer.`),
      );
    }
  }

  if ((manifest.capabilities ?? []).length === 0) {
    warnings.push('Das Modul deklariert noch keine Capabilities.');
  }

  if ((manifest.contributes.ui ?? []).length === 0) {
    warnings.push('Das Modul liefert aktuell keine UI-Contributions.');
  }

  return {
    valid: errors.length === 0,
    source,
    manifest: errors.length === 0 ? manifest : undefined,
    errors,
    warnings,
  };
}

export function validateManifestText(text: string, source = 'inline'): ManifestValidationResult {
  try {
    const document = parseManifestText(text);
    return validateManifestDocument(document, source);
  } catch (error) {
    return {
      valid: false,
      source,
      errors: [
        toIssue(
          'parse-error',
          '/',
          error instanceof Error ? error.message : 'Das Manifest konnte nicht geparst werden.',
        ),
      ],
      warnings: [],
    };
  }
}

export function formatValidationErrors(result: ManifestValidationResult): string {
  return result.errors.map((entry) => `${entry.code} ${entry.path}: ${entry.message}`).join('\n');
}

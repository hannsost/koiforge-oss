import { parseContractReference } from '@koiforge/module-manifest';
import type { ActionContribution, ModuleManifest, ObjectContribution, PropertyDefinition } from '@koiforge/module-manifest';
import semver from 'semver';

import type {
  OntologyActionContract,
  OntologyConflict,
  OntologyObjectContract,
  OntologyProperty,
  OntologySnapshot,
  OntologySourceModule,
  OntologyValidationResult,
} from './types.js';

const reservedObjects = new Set(['user', 'tenant', 'policy', 'auditevent']);

function createProperty(property: PropertyDefinition, contributor: string): OntologyProperty {
  return {
    name: property.name,
    type: property.type,
    required: property.required ?? false,
    computed: property.computed ?? false,
    contributors: [contributor],
  };
}

function addConflict(
  conflicts: OntologyConflict[],
  kind: OntologyConflict['kind'],
  moduleId: string,
  subject: string,
  message: string,
): void {
  conflicts.push({
    kind,
    severity: 'error',
    moduleId,
    subject,
    message,
  });
}

function objectKey(name: string, contractVersion: number): string {
  return `${name}@${contractVersion}`;
}

function actionKey(action: ActionContribution): string {
  return `${action.name}@${action['contract-version']}`;
}

function sameActionSignature(left: OntologyActionContract, right: ActionContribution): boolean {
  const leftPermissions = [...left.permissions].sort().join(',');
  const rightPermissions = [...right.permissions].sort().join(',');
  return left.input === right.input && leftPermissions === rightPermissions;
}

function mergeObjectContribution(
  manifest: ModuleManifest,
  contribution: ObjectContribution,
  objects: Map<string, OntologyObjectContract>,
  conflicts: OntologyConflict[],
): void {
  const key = objectKey(contribution.name, contribution['contract-version']);
  const normalizedName = contribution.name.toLowerCase();

  if (reservedObjects.has(normalizedName)) {
    addConflict(conflicts, 'reserved-object', manifest.id, key, `Objekt '${contribution.name}' ist reserviert.`);
    return;
  }

  const existing = objects.get(key);
  if (existing) {
    if (existing.namespace !== contribution.namespace) {
      addConflict(
        conflicts,
        'namespace-conflict',
        manifest.id,
        key,
        `Objekt '${key}' ist bereits mit Namespace '${existing.namespace}' registriert.`,
      );
      return;
    }

    addConflict(
      conflicts,
      'duplicate-object-contract',
      manifest.id,
      key,
      `Objektvertrag '${key}' wird bereits von Modul '${existing.contributors.join(', ')}' geliefert.`,
    );
    return;
  }

  objects.set(key, {
    key,
    name: contribution.name,
    namespace: contribution.namespace,
    contractVersion: contribution['contract-version'],
    contributors: [manifest.id],
    properties: (contribution.properties ?? []).map((property) => createProperty(property, manifest.id)),
    extensionContributors: [],
  });
}

function applyExtensionContribution(
  manifest: ModuleManifest,
  reference: string,
  properties: PropertyDefinition[] | undefined,
  objects: Map<string, OntologyObjectContract>,
  conflicts: OntologyConflict[],
): void {
  const parsed = parseContractReference(reference);
  if (!parsed) {
    addConflict(conflicts, 'missing-base-object', manifest.id, reference, `Basisobjekt '${reference}' ist ungültig.`);
    return;
  }

  const matches = [...objects.values()].filter(
    (entry) => entry.name === parsed.name && semver.satisfies(`${entry.contractVersion}.0.0`, parsed.range),
  );

  if (matches.length === 0) {
    addConflict(conflicts, 'missing-base-object', manifest.id, reference, `Basisobjekt '${reference}' wurde nicht gefunden.`);
    return;
  }

  for (const object of matches) {
    if (!object.extensionContributors.includes(manifest.id)) {
      object.extensionContributors.push(manifest.id);
    }

    for (const property of properties ?? []) {
      const existingProperty = object.properties.find((entry) => entry.name === property.name);

      if (existingProperty) {
        if (
          existingProperty.type !== property.type ||
          existingProperty.required !== (property.required ?? false) ||
          existingProperty.computed !== (property.computed ?? false)
        ) {
          addConflict(
            conflicts,
            'property-type-conflict',
            manifest.id,
            `${object.key}.${property.name}`,
            `Property '${property.name}' kollidiert mit existierendem Vertrag auf '${object.key}'.`,
          );
        }

        if (!existingProperty.contributors.includes(manifest.id)) {
          existingProperty.contributors.push(manifest.id);
        }
        continue;
      }

      object.properties.push(createProperty(property, manifest.id));
    }
  }
}

function mergeActionContribution(
  manifest: ModuleManifest,
  action: ActionContribution,
  actions: Map<string, OntologyActionContract>,
  conflicts: OntologyConflict[],
): void {
  const key = actionKey(action);
  const existing = actions.get(key);

  if (!existing) {
    actions.set(key, {
      key,
      name: action.name,
      contractVersion: action['contract-version'],
      input: action.input,
      permissions: [...action.permissions],
      contributors: [manifest.id],
    });
    return;
  }

  if (!sameActionSignature(existing, action)) {
    addConflict(
      conflicts,
      'action-signature-conflict',
      manifest.id,
      key,
      `Action '${key}' hat eine abweichende Signatur gegenüber Modul '${existing.contributors.join(', ')}'.`,
    );
    return;
  }

  if (!existing.contributors.includes(manifest.id)) {
    existing.contributors.push(manifest.id);
  }
}

export function validateOntologyModules(modules: OntologySourceModule[]): OntologyValidationResult {
  const objects = new Map<string, OntologyObjectContract>();
  const actions = new Map<string, OntologyActionContract>();
  const conflicts: OntologyConflict[] = [];

  for (const source of modules) {
    for (const contribution of source.manifest.contributes.objects ?? []) {
      mergeObjectContribution(source.manifest, contribution, objects, conflicts);
    }

    for (const extension of source.manifest.contributes.extends ?? []) {
      applyExtensionContribution(source.manifest, extension.object, extension.properties, objects, conflicts);
    }

    for (const action of source.manifest.contributes.actions ?? []) {
      mergeActionContribution(source.manifest, action, actions, conflicts);
    }
  }

  const snapshot: OntologySnapshot = {
    modules: modules.map((entry) => entry.moduleId).sort(),
    objects: [...objects.values()]
      .map((entry) => ({
        ...entry,
        contributors: [...entry.contributors].sort(),
        extensionContributors: [...entry.extensionContributors].sort(),
        properties: [...entry.properties].sort((left, right) => left.name.localeCompare(right.name)),
      }))
      .sort((left, right) => left.key.localeCompare(right.key)),
    actions: [...actions.values()]
      .map((entry) => ({
        ...entry,
        permissions: [...entry.permissions].sort(),
        contributors: [...entry.contributors].sort(),
      }))
      .sort((left, right) => left.key.localeCompare(right.key)),
    extensions: [...objects.values()].reduce((sum, entry) => sum + entry.extensionContributors.length, 0),
  };

  return {
    ok: conflicts.length === 0,
    snapshot,
    conflicts,
  };
}

export function validateManifestMerge(
  existingManifests: OntologySourceModule[],
  incomingManifest: OntologySourceModule,
): OntologyValidationResult {
  return validateOntologyModules([...existingManifests, incomingManifest]);
}

export function buildOntologySnapshot(existingManifests: OntologySourceModule[]): OntologySnapshot {
  return validateOntologyModules(existingManifests).snapshot;
}


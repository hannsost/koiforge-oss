import { DataflowError, type FlowDefinition, type FlowDependencyGraph, type FlowDependencyInput, type FlowDependencyNode, type FlowRun } from './contracts.js';
import { familyIds, FLOW_LIMITS, type FlowState } from './store.js';
import { semanticHash, type SemanticState, type StoredObjectSet } from '../semantic-model/store.js';

export interface DataflowPrincipal { ownerId: string; tenantId: string }

interface PublishedRun {
  output: StoredObjectSet;
  run: FlowRun;
  definition: FlowDefinition;
}

interface LocalProjection {
  node: FlowDependencyNode;
  definition: FlowDefinition;
  publication?: PublishedRun;
  schemaDrift: boolean;
  dataChanged: boolean;
  definitionChanged: boolean;
  provenanceIssues: string[];
}

const DERIVED_DATASET = /^dataflow:([^:]+):([^:]+)$/;

function own(value: { ownerId: string; tenantId: string }, principal: DataflowPrincipal): boolean {
  return value.ownerId === principal.ownerId && value.tenantId === principal.tenantId;
}

function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

function latestDefinitions(state: FlowState, principal: DataflowPrincipal): Map<string, FlowDefinition> {
  if (Object.keys(state.definitions).length > FLOW_LIMITS.definitions) {
    throw new DataflowError('Die Datenflussablage überschreitet ihre Versionsgrenze.', 503);
  }
  const latest = new Map<string, FlowDefinition>();
  for (const definition of Object.values(state.definitions)) {
    if (!own(definition, principal)) continue;
    const prior = latest.get(definition.flowId);
    if (!prior || definition.revision > prior.revision) latest.set(definition.flowId, definition);
    else if (definition.revision === prior.revision) {
      throw new DataflowError('Die Datenflussdefinitionen enthalten widersprüchliche Versionen.', 503);
    }
  }
  return latest;
}

function latestModels(state: SemanticState, principal: DataflowPrincipal): Map<string, StoredObjectSet> {
  const latest = new Map<string, StoredObjectSet>();
  for (const entry of Object.values(state.objectSets)) {
    if (!own(entry.objectSet, principal)) continue;
    const familyId = entry.objectSet.familyId;
    const prior = latest.get(familyId);
    if (!prior || entry.objectSet.revision > prior.objectSet.revision) latest.set(familyId, entry);
    else if (entry.objectSet.revision === prior.objectSet.revision) {
      throw new DataflowError('Die Fachmodellrevisionen enthalten widersprüchliche Versionen.', 503);
    }
  }
  return latest;
}

function derivedReference(value: string): { flowId: string; runId: string } | undefined {
  const match = DERIVED_DATASET.exec(value);
  return match ? { flowId: match[1]!, runId: match[2]! } : undefined;
}

function definitionFamilies(definition: FlowDefinition): string[] {
  try { return familyIds(definition); }
  catch { throw new DataflowError('Eine Datenflussdefinition ist nicht auswertbar.', 503); }
}

function sourceMap(run: FlowRun): Map<string, FlowRun['sources'][number]> | undefined {
  const map = new Map<string, FlowRun['sources'][number]>();
  for (const source of run.sources) {
    if (map.has(source.familyId)) return undefined;
    map.set(source.familyId, source);
  }
  return map;
}

function storedModel(models: SemanticState, setId: string, principal: DataflowPrincipal): StoredObjectSet | undefined {
  const entry = models.objectSets[setId];
  return entry && own(entry.objectSet, principal) ? entry : undefined;
}

function publishedFor(
  state: FlowState,
  models: SemanticState,
  principal: DataflowPrincipal,
  flowId: string,
  definitions: Map<string, FlowDefinition>,
): { publication?: PublishedRun; issue?: string } {
  const candidates = Object.values(models.objectSets)
    .filter(entry => own(entry.objectSet, principal) && entry.objectSet.familyId === flowId)
    .sort((a, b) => b.objectSet.revision - a.objectSet.revision || compareText(b.objectSet.id, a.objectSet.id));
  if (candidates.length === 0) return {};

  // A family is the output family of this flow. A non-dataflow source in that
  // family cannot be treated as a publication, even if it has a plausible id.
  const output = candidates[0]!;
  const reference = derivedReference(output.objectSet.source.datasetId);
  if (!reference || reference.flowId !== flowId) {
    return { issue: 'Die veröffentlichte Ausgabe besitzt keinen gültigen Herkunftsnachweis.' };
  }
  const run = state.runs[reference.runId];
  if (!run || run.id !== reference.runId || run.flowId !== flowId || !own(run, principal) || run.status !== 'ready') {
    return { issue: 'Die veröffentlichte Ausgabe verweist nicht auf einen eigenen bereiten Durchlauf.' };
  }
  const definition = state.definitions[run.definitionId];
  if (!definition || definition.flowId !== flowId || !own(definition, principal) || !definitions.has(flowId)) {
    return { issue: 'Der Herkunftsnachweis der veröffentlichten Ausgabe ist unvollständig.' };
  }
  if (output.objectSet.source.hash !== run.outputHash || output.objectSet.source.rowCount !== run.rowCount
    || semanticHash(output.schema) !== semanticHash(run.schema)
    || output.objectSet.source.columns.length !== run.schema.length
    || output.objectSet.source.columns.some((column, index) => column !== run.schema[index]?.name)
    || output.objectSet.keyField !== definition.spec.keyField
    || (output.objectSet.labelField ?? null) !== (definition.spec.labelField ?? null)) {
    return { issue: 'Die Ausgabe und ihr gespeicherter Durchlauf haben unterschiedliche Datenstände.' };
  }
  return { publication: { output, run, definition } };
}

function producerFor(
  source: StoredObjectSet | undefined,
  familyId: string,
  definitions: Map<string, FlowDefinition>,
  state: FlowState,
  principal: DataflowPrincipal,
  models: Map<string, StoredObjectSet>,
): { producerFlowId?: string; issue?: string } {
  const producer = definitions.get(familyId);
  const reference = source ? derivedReference(source.objectSet.source.datasetId) : undefined;
  if (!source) {
    return producer ? { producerFlowId: familyId } : {};
  }
  if (!reference) {
    // A family that is also a flow output must carry a dataflow provenance.
    return producer ? { producerFlowId: familyId, issue: 'Die Datenflussquelle besitzt keinen gültigen Herkunftsnachweis.' } : {};
  }
  if (reference.flowId !== familyId || !producer) {
    return { issue: 'Die abgeleitete Quelle verweist auf keinen eigenen Produzenten.' };
  }
  const run = state.runs[reference.runId];
  if (!run || run.id !== reference.runId || run.flowId !== reference.flowId || !own(run, principal) || run.status !== 'ready') {
    return { producerFlowId: familyId, issue: 'Die abgeleitete Quelle verweist nicht auf einen eigenen bereiten Durchlauf.' };
  }
  const output = models.get(familyId);
  if (!output || output.objectSet.id !== source.objectSet.id || output.objectSet.source.hash !== run.outputHash) {
    return { producerFlowId: familyId, issue: 'Die abgeleitete Quelle stimmt nicht mit der letzten Produzentenausgabe überein.' };
  }
  return { producerFlowId: familyId };
}

function makeInputs(
  definition: FlowDefinition,
  latest: Map<string, StoredObjectSet>,
  definitions: Map<string, FlowDefinition>,
  state: FlowState,
  principal: DataflowPrincipal,
): { inputs: FlowDependencyInput[]; dependsOn: string[]; provenanceIssues: string[]; schemaDrift: boolean } {
  const inputs: FlowDependencyInput[] = [];
  const dependsOn = new Set<string>();
  const provenanceIssues: string[] = [];
  let schemaDrift = false;
  const families = definitionFamilies(definition);
  for (const familyId of families) {
    const binding = definition.bindings.find(item => item.familyId === familyId);
    const source = latest.get(familyId);
    const producer = producerFor(source, familyId, definitions, state, principal, latest);
    if (producer.producerFlowId) dependsOn.add(producer.producerFlowId);
    if (producer.issue) provenanceIssues.push(producer.issue);
    const schemaChanged = !!source && (!binding || semanticHash(source.schema) !== binding.schemaHash);
    if (schemaChanged) schemaDrift = true;
    inputs.push({
      familyId,
      name: source?.objectSet.name ?? 'Quelle nicht verfügbar',
      ...(source ? { setId: source.objectSet.id, revision: source.objectSet.revision } : {}),
      ...(producer.producerFlowId ? { producerFlowId: producer.producerFlowId } : {}),
      schemaChanged,
      missing: !source,
    });
  }
  const expected = new Set(families);
  if (definition.bindings.length !== families.length || definition.bindings.some(binding => !expected.has(binding.familyId))) {
    provenanceIssues.push('Die Definition besitzt keine eindeutigen Quellenbindungen.');
  }
  return { inputs, dependsOn: [...dependsOn].sort(compareText), provenanceIssues, schemaDrift };
}

function localProjection(
  state: FlowState,
  models: SemanticState,
  principal: DataflowPrincipal,
  definition: FlowDefinition,
  definitions: Map<string, FlowDefinition>,
  latest: Map<string, StoredObjectSet>,
): LocalProjection {
  const familyProjection = makeInputs(definition, latest, definitions, state, principal);
  const output = publishedFor(state, models, principal, definition.flowId, definitions);
  const provenanceIssues = [...familyProjection.provenanceIssues];
  if (output.issue) provenanceIssues.push(output.issue);
  const publication = output.publication;
  let dataChanged = false;
  let definitionChanged = false;
  if (publication) {
    definitionChanged = publication.run.definitionId !== definition.id;
    const persistedSources = sourceMap(publication.run);
    if (!persistedSources) provenanceIssues.push('Der veröffentlichte Durchlauf enthält doppelte Quellen.');
    // A publication must be checked against the definition that produced it.
    // A later definition may intentionally add/remove inputs; that is a
    // needs_run change, rather than corruption of the older publication.
    const publishedFamilies = definitionFamilies(publication.definition);
    if (!persistedSources || persistedSources.size !== publishedFamilies.length || publishedFamilies.some(familyId => !persistedSources.has(familyId))) {
      provenanceIssues.push('Der veröffentlichte Durchlauf enthält keine vollständige Quellenmenge.');
    } else {
      for (const familyId of publishedFamilies) {
        const persisted = persistedSources.get(familyId)!;
        const historical = storedModel(models, persisted.setId, principal);
        const binding = publication.definition.bindings.find(item => item.familyId === familyId);
        if (!historical || historical.objectSet.familyId !== familyId
          || historical.objectSet.revision !== persisted.revision
          || historical.objectSet.source.hash !== persisted.sourceHash
          || historical.objectSet.snapshotHash !== persisted.snapshotHash
          || !binding || semanticHash(historical.schema) !== binding.schemaHash) {
          provenanceIssues.push('Der veröffentlichte Quellenstand ist nicht mehr verifizierbar.');
        }
      }
    }
    const currentFamilies = definitionFamilies(definition);
    const publishedFamilySet = new Set(publishedFamilies);
    if (currentFamilies.length !== publishedFamilies.length || currentFamilies.some(familyId => !publishedFamilySet.has(familyId))) dataChanged = true;
    for (const familyId of currentFamilies) {
      const source = latest.get(familyId);
      const persisted = persistedSources?.get(familyId);
      if (source && (!persisted || persisted.setId !== source.objectSet.id)) dataChanged = true;
    }
  }
  let status: FlowDependencyNode['status'];
  let issues: string[];
  if (provenanceIssues.length || familyProjection.inputs.some(input => input.missing && !input.producerFlowId)) {
    status = 'unavailable';
    issues = [...new Set(provenanceIssues.length ? provenanceIssues : ['Eine bestätigte Quelle ist nicht verfügbar.'])];
  } else if (familyProjection.schemaDrift) {
    status = 'needs_definition';
    issues = ['Das Schema einer Eingabe hat sich geändert; bitte die Datenflussdefinition bestätigen.'];
  } else if (!publication) {
    status = 'unpublished';
    issues = ['Für diesen Datenfluss wurde noch keine Ausgabe veröffentlicht.'];
  } else if (definitionChanged || dataChanged) {
    status = 'needs_run';
    issues = ['Der Datenstand oder die Datenflussdefinition hat sich seit der Veröffentlichung geändert.'];
  } else {
    status = 'current';
    issues = [];
  }
  const node: FlowDependencyNode = {
    flowId: definition.flowId,
    definitionId: definition.id,
    name: definition.spec.name,
    revision: definition.revision,
    status,
    issues,
    inputs: familyProjection.inputs,
    dependsOn: familyProjection.dependsOn,
    affectedFlowIds: [],
    ...(publication ? { published: publication.output.objectSet } : {}),
  };
  return { node, definition, publication, schemaDrift: familyProjection.schemaDrift, dataChanged, definitionChanged, provenanceIssues };
}

function assertAcyclic(nodes: Map<string, FlowDependencyNode>): void {
  const active = new Set<string>();
  const visited = new Set<string>();
  function visit(flowId: string): void {
    if (active.has(flowId)) throw new DataflowError('Die Datenflussabhängigkeiten enthalten einen Zyklus.', 503);
    if (visited.has(flowId)) return;
    active.add(flowId);
    const node = nodes.get(flowId);
    if (node) for (const dependency of node.dependsOn) if (nodes.has(dependency)) visit(dependency);
    active.delete(flowId); visited.add(flowId);
  }
  for (const flowId of [...nodes.keys()].sort(compareText)) visit(flowId);
}

function topological(nodes: Map<string, FlowDependencyNode>, edges: Array<{ fromFlowId: string; toFlowId: string }>): string[] {
  const indegree = new Map<string, number>([...nodes.keys()].map(id => [id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (!nodes.has(edge.fromFlowId) || !nodes.has(edge.toFlowId)) continue;
    indegree.set(edge.toFlowId, (indegree.get(edge.toFlowId) ?? 0) + 1);
    outgoing.set(edge.fromFlowId, [...(outgoing.get(edge.fromFlowId) ?? []), edge.toFlowId]);
  }
  const ready = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id).sort(compareText);
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!; order.push(id);
    for (const child of (outgoing.get(id) ?? []).sort(compareText)) {
      const degree = (indegree.get(child) ?? 0) - 1; indegree.set(child, degree);
      if (degree === 0) { ready.push(child); ready.sort(compareText); }
    }
  }
  if (order.length !== nodes.size) throw new DataflowError('Die Datenflussabhängigkeiten enthalten einen Zyklus.', 503);
  return order;
}

export function projectDependencies(
  state: FlowState,
  models: SemanticState,
  principal: DataflowPrincipal,
): FlowDependencyGraph {
  const definitions = latestDefinitions(state, principal);
  const latest = latestModels(models, principal);
  const projections = new Map<string, LocalProjection>();
  for (const definition of definitions.values()) projections.set(definition.flowId,
    localProjection(state, models, principal, definition, definitions, latest));

  const nodes = new Map<string, FlowDependencyNode>([...projections.entries()].map(([id, projection]) => [id, projection.node]));
  assertAcyclic(nodes);
  const edges = [...nodes.values()].flatMap(node => node.dependsOn.map(fromFlowId => ({ fromFlowId, toFlowId: node.flowId })))
    .filter(edge => nodes.has(edge.fromFlowId))
    .sort((a, b) => compareText(a.fromFlowId, b.fromFlowId) || compareText(a.toFlowId, b.toFlowId));
  const order = topological(nodes, edges);

  // Upstream freshness is part of the meaning of current. A locally valid
  // node remains unavailable when its own provenance is broken; otherwise a
  // stale producer makes the consumer waiting.
  for (const flowId of order) {
    const node = nodes.get(flowId)!;
    if (node.status === 'unavailable') continue;
    if (node.dependsOn.some(dependency => nodes.get(dependency)?.status !== 'current')) {
      node.status = 'waiting';
      node.issues = ['Dieser Datenfluss wartet auf einen aktuellen Vorgänger.'];
    } else if (node.status === 'current') {
      node.issues = [];
    }
  }

  const reverse = new Map<string, string[]>();
  for (const edge of edges) reverse.set(edge.fromFlowId, [...(reverse.get(edge.fromFlowId) ?? []), edge.toFlowId]);
  for (const node of nodes.values()) {
    const affected = new Set<string>();
    const visit = (id: string) => { for (const child of reverse.get(id) ?? []) if (!affected.has(child)) { affected.add(child); visit(child); } };
    visit(node.flowId);
    node.affectedFlowIds = [...affected].sort(compareText);
  }

  const updateOrder = order.filter(flowId => nodes.get(flowId)!.status !== 'current');
  const nextFlowId = order.find(flowId => {
    const node = nodes.get(flowId)!;
    return node.status !== 'current' && node.status !== 'unavailable' && node.status !== 'waiting'
      && node.dependsOn.every(dependency => nodes.get(dependency)?.status === 'current');
  });
  const orderedNodes = [...nodes.values()].sort((a, b) => compareText(a.flowId, b.flowId));
  const projection = { nodes: orderedNodes, edges, updateOrder, ...(nextFlowId ? { nextFlowId } : {}) };
  return { ...projection, graphHash: semanticHash(projection) };
}

export type ImportSourceClass =
  | 'archive_or_bundle'
  | 'connection_config'
  | 'structured_text'
  | 'tabular_text'
  | 'binary_structured'
  | 'binary_runtime_candidate'
  | 'database_entity'
  | 'mixed_source'
  | 'unknown_source';

export type CapabilityGapDimension =
  | 'classify_source'
  | 'inspect_source'
  | 'ask_input'
  | 'runtime_strategy'
  | 'tool_acquisition'
  | 'adapter_generation'
  | 'discover_entities'
  | 'preview_rows'
  | 'import_entity'
  | 'runtime_reload';

export type CapabilityNextAction =
  | 'reuse_existing'
  | 'ask_user_input'
  | 'compose_existing'
  | 'extend_existing'
  | 'acquire_runtime'
  | 'generate_adapter'
  | 'reload_runtime'
  | 'resume_discovery';

export type RuntimeFamily =
  | 'direct_parser'
  | 'embedded_runtime'
  | 'connection_runtime'
  | 'driver_bridge'
  | 'external_tool_bridge'
  | 'adapter_layer'
  | 'none';

export type AcquisitionPath =
  | 'builtin_capability'
  | 'existing_runtime'
  | 'dependency_install'
  | 'system_driver'
  | 'service_binding'
  | 'tool_bridge'
  | 'generated_adapter'
  | 'manual_input'
  | 'none';

export type ExecutionGoal =
  | 'open_source'
  | 'enumerate_entities'
  | 'describe_schema'
  | 'preview_rows'
  | 'stream_rows_for_import'
  | 'register_import_path';

export interface ImportCapabilityRecord {
  id: string;
  kind: 'connector' | 'plugin' | 'parser' | 'discovery' | 'repair';
  handles: {
    sourceKinds: string[];
    fileExtensions?: string[];
    dbEngines?: string[];
    formats?: string[];
  };
  reusePriority: number;
  dependencies: string[];
  files: string[];
  introducedBy: 'builtin' | 'generated' | 'extended';
  successCount: number;
  lastUsedAt?: string;
  notes?: string;
}

export interface ImportInspectorResult {
  nodeId: string;
  nodeLabel: string;
  nodeKind: string;
  sourceClass: ImportSourceClass;
  detectedFormat?: string;
  sourceExtension?: string;
  diagnostics: string[];
  requiredInputs: string[];
  reuseCandidateIds: string[];
  missingDimension: CapabilityGapDimension;
  bestKnownNextAction: CapabilityNextAction;
  capabilityGap: string;
}

export interface ImportPlannerResult {
  planType:
    | 'reuse_existing'
    | 'reuse_with_input'
    | 'compose_existing'
    | 'extend_existing'
    | 'acquire_runtime'
    | 'generate_adapter'
    | 'reload_runtime'
    | 'resume_discovery'
    | 'blocked';
  targetCapabilityId?: string;
  executionMode?: 'tabular_parser' | 'runtime_adapter' | 'entity_discovery' | 'none';
  strategy?: 'csv' | 'json' | 'xml' | 'javascript' | 'sql-insert-dump' | 'db-discovery' | 'none';
  runtimeFamily?: RuntimeFamily;
  acquisitionPath?: AcquisitionPath;
  executionGoals?: ExecutionGoal[];
  params?: Record<string, unknown>;
  reasoning: string;
  expectedOutcome: string;
}

export interface ImportImplementerResult {
  action:
    | 'apply_existing'
    | 'collect_input'
    | 'acquire_runtime'
    | 'generate_adapter'
    | 'reload_runtime'
    | 'resume_discovery'
    | 'blocked';
  runtimeFamily?: RuntimeFamily;
  acquisitionPath?: AcquisitionPath;
  executionGoals?: ExecutionGoal[];
  summary: string;
  steps: string[];
  dependencies: string[];
  targetFiles: string[];
  runtimeArtifacts: string[];
  verificationPlan: string[];
}

export interface ImportVerifierResult {
  verdict: 'resolved' | 'needs_retry' | 'blocked';
  closedGap: boolean;
  summary: string;
  diagnostics: string[];
  resultingCapabilityId?: string;
}

export const IMPORT_INSPECTOR_CONTRACT = `
You are the KOIForge Import Inspector.

Goal:
Understand the selected import node and describe the capability gap that prevents the import flow from continuing.

Rules:
- Distinguish missing user input from missing runtime capability.
- Prefer existing KOIForge capabilities over inventing new ones.
- Think in terms of import continuation, not only file classification.
- Return JSON only.

JSON shape:
{
  "nodeId": "string",
  "nodeLabel": "string",
  "nodeKind": "string",
  "sourceClass": "archive_or_bundle | connection_config | structured_text | tabular_text | binary_structured | binary_runtime_candidate | database_entity | mixed_source | unknown_source",
  "detectedFormat": "string | undefined",
  "sourceExtension": "string | undefined",
  "diagnostics": ["string"],
  "requiredInputs": ["string"],
  "reuseCandidateIds": ["string"],
  "missingDimension": "classify_source | inspect_source | ask_input | runtime_strategy | tool_acquisition | adapter_generation | discover_entities | preview_rows | import_entity | runtime_reload",
  "bestKnownNextAction": "reuse_existing | ask_user_input | compose_existing | extend_existing | acquire_runtime | generate_adapter | reload_runtime | resume_discovery",
  "capabilityGap": "short explanation"
}
`.trim();

export const IMPORT_PLANNER_CONTRACT = `
You are the KOIForge Import Capability Planner.

Goal:
Close the import capability gap for the selected node with the smallest durable capability change.

Priority order:
1. reuse_existing
2. reuse_with_input
3. compose_existing
4. extend_existing
5. acquire_runtime
6. generate_adapter
7. reload_runtime
8. resume_discovery

Rules:
- Do not optimize for concrete file types, products, drivers, or libraries.
- Reason first in source classes, capability gaps, runtime families, acquisition paths, execution goals, and resumable import flow.
- Optimize for making the node discoverable, previewable, and importable.
- If the source is runtime-backed, avoid treating it as a parser problem.
- Choose an individual solution only after reasoning through generic capability families first.
- Return JSON only.

JSON shape:
{
  "planType": "reuse_existing | reuse_with_input | compose_existing | extend_existing | acquire_runtime | generate_adapter | reload_runtime | resume_discovery | blocked",
  "targetCapabilityId": "string | undefined",
  "executionMode": "tabular_parser | runtime_adapter | entity_discovery | none | undefined",
  "strategy": "csv | json | xml | javascript | sql-insert-dump | db-discovery | none | undefined",
  "runtimeFamily": "direct_parser | embedded_runtime | connection_runtime | driver_bridge | external_tool_bridge | adapter_layer | none | undefined",
  "acquisitionPath": "builtin_capability | existing_runtime | dependency_install | system_driver | service_binding | tool_bridge | generated_adapter | manual_input | none | undefined",
  "executionGoals": ["open_source | enumerate_entities | describe_schema | preview_rows | stream_rows_for_import | register_import_path"],
  "params": { "any": "json" },
  "reasoning": "string",
  "expectedOutcome": "string"
}
`.trim();

export const IMPORT_IMPLEMENTER_CONTRACT = `
You are the KOIForge Import Capability Implementer.

Goal:
Translate the chosen import plan into a concrete resumable implementation task.

Rules:
- Reuse existing connector, discovery, preview, and registry paths where possible.
- Prefer extending existing capabilities over inventing parallel systems.
- If only user input is missing, do not create code.
- Choose concrete technologies only as the minimal realization of the selected runtime family and acquisition path.
- Prefer generic access families that can help future sources too.
- Return JSON only.

JSON shape:
{
  "action": "apply_existing | collect_input | acquire_runtime | generate_adapter | reload_runtime | resume_discovery | blocked",
  "runtimeFamily": "direct_parser | embedded_runtime | connection_runtime | driver_bridge | external_tool_bridge | adapter_layer | none | undefined",
  "acquisitionPath": "builtin_capability | existing_runtime | dependency_install | system_driver | service_binding | tool_bridge | generated_adapter | manual_input | none | undefined",
  "executionGoals": ["open_source | enumerate_entities | describe_schema | preview_rows | stream_rows_for_import | register_import_path"],
  "summary": "string",
  "steps": ["string"],
  "dependencies": ["string"],
  "targetFiles": ["string"],
  "runtimeArtifacts": ["string"],
  "verificationPlan": ["string"]
}
`.trim();

export const IMPORT_VERIFIER_CONTRACT = `
You are the KOIForge Import Capability Verifier.

Goal:
Validate whether the selected node can continue through the import flow after repair.

Checks:
- connection or parsing works
- entities can be discovered
- preview can be produced
- import path exists

Rules:
- Return JSON only.

JSON shape:
{
  "verdict": "resolved | needs_retry | blocked",
  "closedGap": true,
  "summary": "string",
  "diagnostics": ["string"],
  "resultingCapabilityId": "string | undefined"
}
`.trim();

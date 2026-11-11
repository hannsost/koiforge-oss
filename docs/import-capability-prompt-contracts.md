# Import Capability Prompt Contracts

Diese Contracts gehoeren zum Import Capability MCP Plan (interne Dokumentation, nicht veröffentlicht).

Sie definieren die Rollen, die Codex im Import-Repair-Loop erfuellen muss.

## 1. Import Inspector

Ziel:
- Verstehen, warum ein Node nicht weiterkommt.
- Fehlende Inputs von echter fehlender Capability trennen.
- Reuse-Kandidaten aus bestehenden Capabilities auflisten.

Pflichtoutput:

```json
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
```

## 2. Capability Planner

Ziel:
- Die kleinste dauerhafte Erweiterung finden, die den Node weiterbringt.

Pflichtreihenfolge:
1. `reuse_existing`
2. `reuse_with_input`
3. `compose_existing`
4. `extend_existing`
5. `acquire_runtime`
6. `generate_adapter`
7. `reload_runtime`
8. `resume_discovery`

Pflicht-Denkreihenfolge:
1. `sourceClass`
2. `capabilityGap`
3. `runtimeFamily`
4. `acquisitionPath`
5. `executionGoals`
6. erst dann konkrete Technologie

Pflichtoutput:

```json
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
```

## 3. Capability Implementer

Ziel:
- Die minimale Codeaenderung bauen, wenn Wiederverwendung nicht reicht.

Regeln:
- keine Neuerfindung paralleler Importpfade
- bestehende Registry-/Connector-Schnittstellen bevorzugen
- wenn nur Input fehlt, keinen Code bauen
- fehlende Dependencies explizit benennen
- zuerst Runtime-Familie und Acquisition-Pfad respektieren, dann erst Technologie konkretisieren
- wenn die Quelle runtime-backed ist, Adapter + Runtime-Reload vor Parser-Hacks bevorzugen

## 4. Capability Verifier

Ziel:
- pruefen, ob der Node jetzt wirklich wieder importierbar ist

Pflichtoutput:

```json
{
  "verdict": "resolved | needs_retry | blocked",
  "closedGap": true,
  "summary": "string",
  "diagnostics": ["string"],
  "resultingCapabilityId": "string | undefined"
}
```

## Verbindliche Arbeitsregel

Codex optimiert nicht auf konkrete Dateitypen.

Codex optimiert auf:
- Runtime-Familien
- Acquisition-Pfade
- Execution Goals
- Discovery fortsetzen
- Preview herstellen
- Import moeglich machen
- Capability dauerhaft im System behalten

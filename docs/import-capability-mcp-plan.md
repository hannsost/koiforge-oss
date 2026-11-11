# KOIForge Import Capability MCP Plan

## Status
Source of truth fuer den weiteren Ausbau des Import-Systems.

Dieses Dokument soll verhindern, dass die Umsetzung wieder in harte Einzel-Loesungen abrutscht.

## Ziel
KOIForge soll ein selbst-erweiterndes Import-System werden:

- Der Nutzer wirft beliebige Dateien, Archive, Dumps, Konfigs oder DB-Hinweise in den Import.
- Das System baut daraus einen Import-Baum.
- Wenn etwas bereits importierbar ist, wird die bestehende Funktion genutzt.
- Wenn etwas fast importierbar ist, wird die bestehende Funktion minimal erweitert.
- Wenn etwas noch nicht importierbar ist, baut Codex die fehlende Capability on the fly.
- Danach wird der Importfluss ohne KOIForge-Neustart fortgesetzt.
- Jede geloeste Capability bleibt erhalten und beschleunigt spaetere aehnliche Faelle.

## Nicht-Ziel

- Keine Sammlung von hart codierten Spezialfaellen.
- Kein rein heuristischer Parser-Zoo ohne Memory.
- Kein System, das nur Formate klassifiziert, aber den Import nicht wirklich zu Ende fuehrt.
- Kein kompletter App-Neustart pro neuem Importfall.

## Leitprinzipien

1. Reuse First
   - Immer zuerst pruefen, ob bereits etwas Vorhandenes reicht.
   - Reihenfolge:
     1. bestehende Capability direkt nutzen
     2. bestehende Capability mit zusaetzlichem Input nutzen
     3. bestehende Capabilities kombinieren
     4. bestehende Capability minimal erweitern
     5. neue Capability bauen

2. Capability Gap statt Formatdenken
   - Das Problem ist nicht primaer "welcher Dateityp ist das?".
   - Das Problem ist: "welche Faehigkeit fehlt, damit dieser Node importierbar wird?".

3. Capability Memory
   - Jede erfolgreich gebaute oder erweiterte Importfaehigkeit wird persistiert.
   - Spaetere Imports muessen diese Loesung wiederverwenden koennen.

4. Control Plane stabil halten
   - KOIForge UI und Control Plane bleiben online.
   - Wenn Reload noetig ist, betrifft er nur Import-Worker/Runtime oder Plugin-Loader.

5. Explainable Evolution
   - Das System muss sagen koennen:
     - was fehlte
     - was wiederverwendet wurde
     - was erweitert wurde
     - was neu gebaut wurde
     - warum

6. Kein Hardcoding von Demo-Faellen
   - Keine Sonderbehandlung fuer einzelne Datenquellen oder Beispiel-Datasets.
   - Auch DB-Import darf nicht als feste Liste statischer Spezial-Connectoren gedacht werden.

## Kernidee: Mehrdimensionales MCP fuer Ingestion

Das Import-System wird als Capability-orientiertes MCP gedacht, nicht als starre Connector-Liste.

### Dimensionen

1. Source Dimension
   - archive_or_bundle
   - connection_config
   - structured_text
   - tabular_text
   - binary_structured
   - binary_runtime_candidate
   - database_entity
   - mixed_source
   - unknown_source

2. Capability Dimension
   - classify_source
   - extract
   - inspect_source
   - ask_input
   - runtime_strategy
   - tool_acquisition
   - adapter_generation
   - discover_entities
   - preview_rows
   - import_entity
   - runtime_reload

3a. Runtime Family Dimension
   - direct_parser
   - embedded_runtime
   - connection_runtime
   - driver_bridge
   - external_tool_bridge
   - adapter_layer

3b. Acquisition Path Dimension
   - builtin_capability
   - existing_runtime
   - dependency_install
   - system_driver
   - service_binding
   - tool_bridge
   - generated_adapter
   - manual_input

4. Repair / Evolution Dimension
   - reuse_existing
   - reuse_with_input
   - compose_existing
   - extend_existing
   - acquire_runtime
   - generate_adapter
   - reload_runtime
   - resume_discovery

5. Runtime Dimension
   - control-plane-api
   - import runtime
   - generated plugin
   - connector adapter

6. Knowledge Dimension
   - builtin
   - generated
   - repo pattern reuse
   - dependency-backed
   - newly synthesized

## Architektur

### 1. Import Session Backbone
Der Nutzer arbeitet immer gegen eine `ImportSession`.

Sie enthaelt:

- staging files
- discovery tree
- selected nodes
- forms / missing input
- gaps
- logs
- repair history
- imported dataset results

### 2. Import Tree
Der Tree ist sofort sichtbar, auch wenn noch nicht alles verstanden wurde.

Ein Node kann sein:

- `folder`
- `archive`
- `file`
- `excel-workbook`
- `sheet`
- `json-array`
- `xml-table`
- `sqlite-database`
- `db-connection`
- `db-table`
- spaeter auch:
  - `mongo-collection`
  - `db-schema`
  - `api-endpoint`
  - `object-storage-object`

### 3. Capability Catalog
KOIForge braucht ein maschinenlesbares Inventar aller Importfaehigkeiten.

Beispiel:

```ts
type ImportCapabilityRecord = {
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
};
```

### 4. Capability Gap
Wenn ein Node nicht weiterkommt, wird ein Gap erzeugt.

Beispiel:

```ts
type CapabilityGap = {
  id: string;
  sourceNodeId: string;
  missingDimension:
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
  bestKnownNextAction:
    | 'reuse_existing'
    | 'ask_user_input'
    | 'extend_existing'
    | 'acquire_runtime'
    | 'generate_adapter'
    | 'reload_runtime'
    | 'resume_discovery';
  diagnostics: string[];
  status: 'open' | 'in_progress' | 'resolved' | 'blocked';
};
```

### 5. Runtime-Schnitt
KOIForge darf fuer neue Importfaehigkeiten nicht komplett neu starten muessen.

Deshalb:

- Control Plane bleibt stabil
- Import Runtime / Plugin Loader darf reloaden
- Nach Reload wird die betroffene Session fortgesetzt

## Prompt-gesteuerter Capability-Closing Loop

Codex wird nicht als freier Parser benutzt, sondern als gezielter Capability-Builder.

### Rolle 1: Import Inspector
Aufgabe:

- Material und Kontext verstehen
- fehlende Inputs trennen von echter fehlender Capability
- bestehende Reuse-Kandidaten auflisten

Output:

- classification
- reuse_candidates
- required_inputs
- capability_gap

### Rolle 2: Capability Planner
Aufgabe:

- entscheiden, wie der Gap mit minimalem Eingriff geschlossen wird

Pflichtreihenfolge:

1. reuse existing
2. reuse with input form
3. compose existing
4. extend existing
5. acquire runtime
6. generate adapter
7. reload runtime
8. resume discovery

Wichtige Regel:

- Nicht auf konkrete Dateitypen optimieren.
- Auf Import-Fortsetzung optimieren.
- Zuerst Runtime-Familie und Acquisition-Pfad waehlen, erst danach konkrete Technologie instanziieren.
- Wenn eine Quelle binary oder runtime-backed ist, darf der Planner nicht mit einem Text-Parser-Blocker enden.

### Rolle 3: Capability Implementer
Aufgabe:

- exakt die minimale Codeaenderung implementieren
- an bestehende Registry-/Connector-/Plugin-Schnittstellen andocken
- keine Voll-Neuerfindung ohne Not

### Rolle 4: Capability Verifier
Aufgabe:

- pruefen, ob der Gap wirklich geschlossen ist

Checkliste:

- Verbindung moeglich?
- Tabellen/Collections/Entities discoverbar?
- Preview ladbar?
- Import moeglich?
- Node geht von `gap` oder `needs_input` nach `ready`?

Wenn nein:

- praezise Diagnose zurueck an den Planner

## Runtime-backed Quellen

Wichtig:

- Die konkrete Technologie ist zweitrangig.
- Entscheidend ist, welche Faehigkeit fehlt, damit Discovery, Preview und Import fortgesetzt werden koennen.

Trenne immer:

1. fehlende Zugangsdaten
2. fehlende Runtime-Strategie
3. fehlende Tool-/Driver-Beschaffung
4. fehlende Adapter-Generierung
5. fehlende Entity-Discovery
6. fehlende Preview-Logik
7. fehlende Import-Logik

Nur 2 bis 7 sind echte Capability-Probleme.
Punkt 1 ist meist ein Input-Problem.

## UI-Anforderungen

### Import Workspace

- Multi-Upload
- rekursiver Import-Baum
- alles standardmaessig selektiert
- Checkboxen auf Node-Ebene
- aufklappbare Unterstrukturen
- mehrere Wurzelbaeume pro Session moeglich

### Detailbereich

- Node Preview
- erkannte Quelle / Typ
- genutzte oder geplante Capability
- fehlende Eingaben
- Formulare dynamisch aus Capability-Schema
- Logs und Reparaturhistorie sichtbar

### Verhalten

- Baum soll bereits sichtbar sein, bevor alles geloest ist
- neue Unterknoten duerfen im laufenden Prozess erscheinen
- nach Plugin-/Runtime-Reload soll die Session live aktualisierbar sein

## Persistenz

Folgendes muss behalten werden:

- generierte Plugins
- erweiterte Capability-Metadaten
- Repair-Historie
- Success Count / Last Used
- Input-Schemas fuer wiederkehrende Faelle

## Verbotene Muster

Diese Dinge gelten als Fehlrichtung:

- Harte Demo-Sonderfaelle
- Importlogik direkt in View-Komponenten
- neue Capability bauen, ohne Reuse-First geprueft zu haben
- harte Sonderpfade fuer einzelne Technologien im Prompt-Loop
- einmalige Parser-Hacks ohne Persistenz
- Ad-hoc-Fixes, die nicht in Capability Memory zurueckfliessen

## Umsetzungsreihenfolge

### Phase 1: Stabiles Backbone
- `ImportSession`
- `ImportTree`
- Upload / Staging / Discovery
- Auswahlbaum
- dynamische Input-Formulare

### Phase 2: Capability Catalog
- explizites Capability-Inventar
- Reuse-Prioritaeten
- Gap-Klassifikation nach fehlender Dimension

### Phase 3: Prompt-Loop
- Inspector Prompt
- Planner Prompt
- Implementer Prompt
- Verifier Prompt
- JSON-Schemas fuer alle Outputs

### Phase 4: Runtime Evolution
- generierte Plugins
- Runtime-Reload
- Session-Fortsetzung ohne App-Neustart

### Phase 5: Live-Import Capabilities
- DB discovery
- live preview
- entity import
- dependency-backed extensions

### Phase 6: Beschleunigung durch Memory
- generated capability reuse
- ranking erfolgreicher Muster
- schnellere Bearbeitung bekannter Quellen

## Akzeptanzkriterien

Das System gilt erst dann als auf Kurs, wenn folgende Faelle moeglich sind:

1. Gemischtes Upload-Bundle
   - Mehrere Dateien, Archive, Unterarchive und Dumps ergeben einen sinnvollen Baum.

2. Reuse vor Neubau
   - Ein bestehender Importpfad wird verwendet oder minimal erweitert, bevor etwas Neues gebaut wird.

3. DB-Import mit fehlenden Angaben
   - Das System fordert nur die wirklich fehlenden Inputs nach.

4. Echte Capability-Erweiterung
   - Wenn Discovery/Preview/Import fehlt, kann Codex die Luecke schliessen.

5. Kein KOIForge-Neustart
   - Session bleibt erhalten, UI bleibt offen, Runtime wird hoechstens lokal neu geladen.

6. Memory-Effekt
   - Ein spaeterer aehnlicher Importfall wird schneller und mit weniger manueller Arbeit geloest.

## Arbeitsregeln fuer kommende Umsetzung

Bei jeder weiteren Aenderung an der Import-Architektur gilt:

1. Vor jeder Implementierung gegen dieses Dokument pruefen.
2. Keine harte Fall-Logik einbauen, wenn stattdessen eine Capability-Abstraktion moeglich ist.
3. Jede neue Loesung muss beantworten:
   - Was war der Gap?
   - Was wurde wiederverwendet?
   - Was wurde erweitert?
   - Was wird jetzt fuer spaetere Faelle gespeichert?
4. Wenn eine Aenderung nur einen Sonderfall fixt, aber keine Capability verbessert, ist sie wahrscheinlich falsch.
5. Wenn eine neue Runtime-Dependency noetig ist, muss sie als Teil des Capability-Closing-Loops betrachtet werden, nicht als Sonderfall.

## Nächster konkreter Arbeitsschritt

Als naechstes wird das bestehende Import-System auf dieses Modell abgebildet:

- vorhandene Teile inventarisieren
- echtes `CapabilityCatalog` einfuehren
- bestehende `gap`-Logik auf fehlende Dimensionen umstellen
- Prompt-Kontrakte fuer Inspector / Planner / Verifier ins Repo schreiben

# ADR 0002 – Manifest-ABI als erster maschinenlesbarer Vertrag

## Status

Accepted

## Kontext

Der Plan benennt die Ontology ABI und die Manifest-Validierung als zentrale Architekturartefakte. Bereits in Woche 2–3 sollen Contract Model, Merge Rules und `module.schema.json` festgelegt werden.

## Entscheidung

Das initiale Prototyping startet mit einem formalen Manifest-Vertrag, der mindestens folgende Bereiche abdeckt:

- Modulidentität und Version
- Trust Level
- Core- und Ontology-Abhängigkeiten
- Contributions für Objects, Extensions, Actions, UI und Policies
- Migrationshistorie
- Kompatibilitätstests

Zusätzlich zur JSON-Schema-Prüfung werden semantische Regeln umgesetzt:

- SemVer-Validierung
- Prüfung von Contract-Referenzen
- Duplikaterkennung für Objekte und Actions
- Mindestkonsistenz von Migrationsangaben

## Begründung

- JSON-Schema allein reicht für ABI-Kompatibilität nicht aus
- Semantische Prüfungen schaffen eine erste Installation-Gatekeeper-Schicht
- Der Vertrag kann später für Marketplace, SDKs und Policy-Impact-Analysen wiederverwendet werden

## Konsequenzen

- Die Merge- und Conflict-Engine ist noch nicht vollständig implementiert
- Der aktuelle Fokus liegt auf sicheren additiven Contributions
- Weitere Reserved/Core-only-Regeln werden in späteren ADRs präzisiert


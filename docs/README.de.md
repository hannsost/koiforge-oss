# KOIForge

KoiForge verbindet betriebliche Fragen mit Quellen, bestätigten Prüfregeln und
nachvollziehbaren Ergebnissen. Die Arbeitsfläche **Aufträge** speichert Planung,
Quellenstand und Befunde über Navigation und Neustarts hinweg. Quellenalter sowie
Vollständigkeit und doppelte Schlüssel sind die ersten ausführbaren Fähigkeiten.

Im **Fachmodell** erhalten Quellen bestätigte Fachnamen, ID-Felder und Beziehungen.
KoiForge prüft fehlende oder mehrdeutige Zuordnungen zwischen zwei gespeicherten
Objektmengen. Neue Revisionen erhalten frühere Befunde; Beziehungsprüfungen sind
auch als agentengeführte Aufträge ausführbar.

Auf dieser Grundlage prüft das erste Fachpaket **offene Bestellungen**:
ausdrücklich bestätigte Statuswerte und zugesagte Lieferkalendertage ergeben
eine priorisierte Klärungsliste. Fehlende Termine und ungeklärte Lieferanten
bleiben erkennbar. Dazu gibt es
[synthetische Beispieldateien](../examples/order-review/README.md).

Abgeschlossene Bestellprüfungen lassen sich als **Routinen** speichern. Vor einem
weiteren Lauf zeigt KoiForge neue Quellenrevisionen, unbekannte Statuswerte und
veränderte Kennzahlen. Die bestätigten Fachregeln bleiben erhalten; jeder Lauf
braucht einen ausgewählten Datenstand, Stichtag und eine ausdrückliche Bestätigung.

Aus überfälligen Bestellungen und Befunden mit Klärungsbedarf entstehen
**Klärungsfälle**. Die vollständige Befundauswahl reicht über die Ergebnisvorschau
hinaus. Übernahme, Abschlussnotiz und Wiederöffnung werden mit Person und Zeitpunkt
gespeichert; der ursprüngliche Quellenbefund bleibt erhalten.

Abgeschlossene Routinenläufe zeigen jetzt, welche **Befunde neu auffällig sind,
fortbestehen oder im neuen Stand nicht mehr auftreten**. Vorher-/Nachher-Belege
und bestehende Fallakten bleiben verknüpft; fehlende oder doppelte IDs werden
nicht als gelöst gewertet.

Der allgemeine **Objekt-Explorer** verbindet bestätigte Fachmodelle über stabile
Objektadressen. Suche und Filter erfassen vollständige Quellenstände; Beziehungen
lassen sich vorwärts und rückwärts verfolgen, mit Revisionen und Herkunft am
Objekt. Kunden, Projekte und Tickets verwenden denselben Vertrag wie Bestellungen.

Auftragsplanung und Selbsterweiterung verwenden standardmäßig den konfigurierten
OpenAI-kompatiblen AIP-Endpunkt (`api`). Mit `KOIFORGE_EXTENSION_BACKEND=codex`
kann optional die lokale Codex-CLI mit bestehender ChatGPT-Anmeldung genutzt
werden (`gpt-6-astra` und `xhigh` als Vorgaben). Erzeugte Module werden in einer
begrenzten Linux-Laufzeit geprüft und für weitere Fälle gespeichert. [Selbst testen und Grenzen](SELF-EXTENSION-TESTING.md).

Aktuell umgesetzt:

- Monorepo-Grundstruktur mit `pnpm` und `turbo`
- Security-Core mit Tenant-, Role- und Permission-Modell
- Config-/Secrets-Core mit tenantfähigen Einträgen und Secret-Referenzen
- Ontology-Core mit Registry, Snapshot und Merge-Validator
- Asset-/Lineage-Core mit Asset Registry, Run History und Lineage Events
- Erste nutzbare Datenansichten mit Dataset Preview und Object Explorer
- Saved Views für Dataset Preview und Object Explorer
- Mehrfachfilter/Filterchips und Board-Viewer für verschiebbare/verknüpfbare Datensätze
- Resilience-Lab mit Dirty-Data-Szenarien, Invariants und Incident Bundles
- Playwright-E2E für echte DOM- und Board-Interaktionen
- JSON-Schema `module.schema.json` für KOIForge-Module
- YAML/JSON-Manifest-Validator mit semantischen Zusatzprüfungen
- Datei-basierter Modul-Registry-Prototyp mit `install`, `enable`, `disable`, `rollback`
- Control-Plane-API für Manifest-Validierung, Modul-Lifecycle, Audit und Beispiel-Bootstrap
- React- + Tailwind-Shell als Startpunkt für das UI-Slot-System
- ADRs für Monorepo/Stack und die Ontology-/Manifest-ABI

## Workspace

- `apps/control-plane-api` – Backend-Prototyp für Manifest- und Modulverwaltung
- `apps/console-web` – UI-Shell mit Slot-Übersicht und Audit-Ansicht
- `packages/config-core` – Config Registry, Secret-Metadaten und Secret-Referenzen
- `packages/data-registry` – Dataset Registry, SQL-Metadaten und Built-in-Connectoren
- `packages/module-manifest` – Manifest-Typen, JSON-Schema, Parser und Validator
- `packages/module-system` – Datei-basierte Registry und Lifecycle-Logik
- `packages/ontology-core` – Ontology Snapshot, Objektverträge und Conflict-Detection
- `packages/asset-lineage-core` – Assets, Lineage-Kanten, Runs und Event-History
- `packages/resilience-lab` – Dirty-Data-Szenarien, Invariant-Checks und Incident Bundles
- `examples/modules` – Beispielmodule für Procurement/Supplier Risk

## Schnellstart

Unter Linux/Omarchy (Node, pnpm, bubblewrap und systemd-Benutzersitzung):

```bash
pnpm install --frozen-lockfile
pnpm --filter @koiforge/control-plane-api... build
pnpm start:local
```

UI: `http://127.0.0.1:5173`, API: `http://127.0.0.1:3100/health`.
Der Linux-Start bindet an Loopback, prüft freie Ports und speichert lokale Zustände
unter `.koiforge/`; Strg+C beendet beide Prozesse. `KOIFORGE_API_PORT`,
`KOIFORGE_WEB_PORT` und `KOIFORGE_STATE_ROOT` überschreiben diese Vorgaben.
`start:local` baut die Oberfläche und startet sie zusammen mit der API. Änderungen
an der Oberfläche werden beim nächsten Start gebaut. Für Entwicklung mit sofort
sichtbaren Änderungen bleibt `pnpm dev:linux` verfügbar. Das ist ein lokaler
Vorschaubetrieb mit einer Firma und einem schreibenden API-Prozess, keine
Clusterbereitstellung. Bei Wahl des Codex-Backends muss die CLI lokal angemeldet sein; Beispiele werden
nie automatisch als Kundendaten angelegt. Ohne direkt installiertes pnpm können die
Befehle mit `npm exec --yes --package=pnpm@10.18.3 -- pnpm …` ausgeführt werden.

Für den lokalen Betrieb gibt es eine (interne Dokumentation, nicht veröffentlicht).
Nach dem Beenden der API sichert `node scripts/state.mjs backup --root /absoluter/pfad/.koiforge --output /absoluter/pfad/sicherung`
den vollständigen Speicherordner. `verify --backup /absoluter/pfad/sicherung`
prüft Dateibestand und Prüfsummen. Die Wiederherstellung erfolgt ausschließlich
am ursprünglichen, nicht vorhandenen Speicherort; bestehende Daten werden nicht
überschrieben. API und Sicherungswerkzeug sperren denselben Speicher gegen
gleichzeitigen Zugriff. Dieses Verfahren gilt für lokale Linux-Dateisysteme.

Historischer separater Start (Windows-Hilfsskripte siehe unten; die aktuelle API
mit exklusivem Prozessschutz benötigt Linux):

```bash
pnpm install
pnpm build
pnpm api:dev
pnpm web:dev
```

Danach:

- API: `http://127.0.0.1:3000/health`
- UI: `http://localhost:5173`

In der UI kann per Button die Beispielinstallation ausgeführt werden.

Aktuell direkt nutzbar:

- Dataset-Auswahl mit Tabellenvorschau
- Object Explorer für `supplier` und `procurement-order`
- Objekt-Detailansicht mit ersten Relationen
- Speichern und Laden von Ansichten für Preview und Object Explorer
- Mehrere gleichzeitige Filterchips für Preview und Explorer
- Board-Viewer zum Platzieren, Verschieben und Verknüpfen von Objekten

## Komfortabler lokaler Testlauf

Unter Windows / PowerShell stehen Hilfsskripte bereit:

```bash
pnpm dev:start
pnpm smoke
pnpm dev:stop
```

Dabei gilt:

- `pnpm dev:start` startet API und UI im Hintergrund
- `pnpm smoke` führt einen kleinen End-to-End-Sanity-Check über die wichtigsten Endpoints aus
- `pnpm dev:stop` beendet die gestarteten Prozesse wieder
- Standardmäßig nutzt `pnpm dev:start` den API-Port `3100`, damit ein belegter Port `3000` nicht stört
- Standardmäßig ist die UI danach unter `http://localhost:5173` erreichbar

Bei Bedarf kannst du Ports explizit angeben:

```powershell
./scripts/start-dev.ps1 -ApiPort 3200 -WebPort 5174
./scripts/smoke-test.ps1 -ApiBaseUrl http://127.0.0.1:3200
./scripts/stop-dev.ps1
```

Logs werden unter `.koiforge/logs/` abgelegt.

## Browser-E2E

Die Prüfung des aktuellen Produktablaufs unter Linux startet eine isolierte API
mit synthetischen Daten und die gebaute Oberfläche:

```bash
cd packages/e2e-tests
KOIFORGE_E2E_PRODUCTION=1 pnpm exec playwright test --config playwright.freshness.config.ts
```

Sie prüft Aufträge, Quellenalter, mobile Bedienung und Anmeldung. Die Browserprüfung
verwendet Modell-Testdoubles; der echte lokale Astra-Lauf wurde separat geprüft.
[Abnahmebelege].

Playwright startet die lokale App, steuert das DOM an und prüft Explorer/Board wirklich im Browser:

```bash
pnpm e2e
```

Aktuell abgedeckt:

- Dataset Preview im DOM
- Object Explorer ohne 404-Race-Conditions
- Board-Views laden
- Karten auf dem Board ziehen
- Gruppierungsmodus im Board umschalten

## Resilience Loop

Verfügbare Szenarien anzeigen:

```bash
pnpm resilience:list
```

Ein Szenario mit Incident Bundle ausführen:

```bash
pnpm resilience:run -- --scenario identity-drift-001
```

Mit kompletter Regression nach dem Szenariolauf:

```bash
pnpm resilience:run -- --scenario identity-drift-001 --with-regression
```

Artefakte landen unter `.koiforge/resilience-runs/<run-id>/` und enthalten u. a.:

- `scenario.json`
- `before_snapshot.json`
- `after_snapshot.json`
- `invariants.json`
- `logs.jsonl`
- `regression_summary.json`
- `summary.json`
- `triage.json`
- `ai_handoff.json`
- `ai_handoff.md`

Eine bestehende Ausführung automatisch zusammenfassen:

```bash
pnpm resilience:triage
```

## Anmeldung

Eine leere lokale Instanz führt durch die Einrichtung eines Inhaberkontos.
Danach ist eine Anmeldung erforderlich. Die API prüft serverseitige Sitzungen;
Abmelden widerruft den Zugang. User- oder Tenant-Header ersetzen keine Anmeldung.
Der aktuelle Betriebsumfang ist eine Firma pro Installation mit einem Inhaber.
 (interne Dokumentation, nicht veröffentlicht).

## Nächste sinnvolle Ausbaustufen

- Persistente Dataset Registry und erste Connector-Abstraktion
- Install/Upgrade-Flow um Dependency-Graph und Trust-Signaturen erweitern
- Event Bus und Audit nicht nur für Module, sondern auch für Actions/Jobs modellieren
- Objektmodell/Ontology-Registry auf Basis der Manifest-Contributions persistieren
- Connector-SDK für externe Implementierungen und echte Source-Probing-Adapter ergänzen

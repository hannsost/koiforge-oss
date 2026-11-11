# ADR 0001 – Monorepo und initialer Core-Stack

## Status

Accepted

## Kontext

Der Realisierungsplan empfiehlt in den ersten Wochen explizit:

- Monorepo aufsetzen
- `module.schema.json` definieren
- Manifest-Loader prototypisch implementieren
- Design-System-Grundgerüst mit React + Tailwind schaffen

Gleichzeitig ist KOIForge als Plattform-Kernel mit klarer Trennung zwischen Core und Modulen gedacht.

## Entscheidung

Wir starten mit einem TypeScript-Monorepo auf Basis von `pnpm` und `turbo`.

- `apps/control-plane-api` kapselt erste Core-Funktionen für Modulverwaltung
- `apps/console-web` bildet die UI-Shell für Slot-basierte Erweiterungen ab
- `packages/module-manifest` hält Manifest-ABI, Parser und Validator
- `packages/module-system` kapselt Registry- und Lifecycle-Logik

## Begründung

- Geringe Startkomplexität bei guter Erweiterbarkeit
- Getrennte Pakete erzwingen klare Verantwortlichkeiten zwischen ABI und Runtime
- TypeScript ist für Validator, API und UI schnell produktiv und gut testbar
- React + Tailwind entspricht direkt dem Plan für das UI-Grundgerüst

## Konsequenzen

- Module Federation, Temporal und Iceberg/Polaris sind noch nicht integriert
- Der aktuelle Persistenz-Layer ist bewusst nur ein Datei-Prototyp
- Die Struktur ist so gewählt, dass spätere Adapter und SDKs ohne große Umbenennungen ergänzt werden können


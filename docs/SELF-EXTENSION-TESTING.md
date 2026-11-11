# Selbsterweiterung lokal testen

Stand: 22.09.2026. Entwicklungsstand auf Branch `codex/koiforge-ke0`.
Die Windows-Quellbasis bleibt erhalten. Der erste technische Slice besteht aus
KE0, dem Parserpfad KE1 und dem begrenzten Zeitvergleich KE2.

## Start unter Linux/Omarchy

Im vorbereiteten Worktree `../koiforge-ke0`:

```bash
node scripts/dev-linux.mjs
```

Öffnen: http://127.0.0.1:5173. Strg+C beendet API und UI. Der Start verweigert
belegte Ports; alternative Ports setzen:

```bash
KOIFORGE_API_PORT=3101 KOIFORGE_WEB_PORT=5174 node scripts/dev-linux.mjs
```

Lokale Daten und Providerkonfiguration liegen in `.koiforge/`. Ein anderer
`KOIFORGE_STATE_ROOT` erzeugt eine getrennte Entwicklungsumgebung. Keine
Windows-Daten oder alten unüberprüften Plugins werden automatisch übernommen.
Es gibt keinen Windows-/PowerShell-Fallback für erzeugten Code. Benötigt werden
Node, bubblewrap, systemd-Benutzersitzung und delegierte Cgroups v2.

Bei einer frischen Installation zuerst `pnpm install --frozen-lockfile` und
`pnpm --filter @koiforge/control-plane-api... build`. Falls pnpm nicht direkt
installiert ist: `npm exec --yes --package=pnpm@10.18.3 -- pnpm …`.

## Quellenalter prüfen

1. Einen Provider in **AIP** konfigurieren. Der erste Lauf erzeugt den fehlenden
   Analysebaustein. Ohne Provider zeigt die App einen blockierten Lauf; es gibt
   keine heimlich installierte Beispielimplementierung.
2. Im **Project Workspace** den Import-Workspace öffnen und
   `examples/self-extension/source-status.csv` importieren. Das sind ausdrücklich
   synthetische Beispiele, keine Unternehmensdaten.
3. Zu **Auswertungen** wechseln. Quelle auswählen, Quellschlüssel `id` und
   Aktualisierungszeitpunkt `updated` bestätigen. Stichtag
   `2026-09-22T12:00:00Z`, erlaubtes Alter **1 Stunde** setzen und die Bedeutung
   des Zeitstempels bestätigen.
4. Ausführen. Erwartung: eine aktuelle, eine veraltete und eine nicht
   beurteilbare Quelle. Der Lauf speichert Eingabezeilen, Regel, Ergebnisse,
   Hashes und Ausführungsbelege. Unbekannte Zeitstempel werden nicht zur Importzeit.
5. Einen weiteren passenden Datensatz mit anderer Feldbenennung importieren,
   neu zuordnen und ausführen. Das vorhandene geprüfte Modul wird wiederverwendet.
   In den technischen Belegen bleiben Modulhash und Generierungszähler sichtbar.

Der Zeitvergleich beantwortet ausschließlich die bestätigte Altersregel. Er
bestimmt weder offene Bestellmengen noch Lieferprognosen. Eine freie Geschäftsfrage
ist der Name des Falls; sie ändert nicht still die bestätigte Rechenregel.

## Einen neuen Textparser ergänzen

1. `examples/self-extension/orders.supply` im Import-Workspace hochladen. Ohne
   vorhandenes Modul erscheint eine fehlende Fähigkeit.
2. Den Quellknoten konfigurieren: Formatbeschreibung „Erste Zeile SUPPLY/1,
   zweite Zeile zwei unterschiedliche Spaltennamen getrennt durch |, danach
   pro Zeile zwei nichtleere Werte; fehlerhafte Zeilen ablehnen, vollständigen
   Inhalt lesen“. Den Inhalt von `parser-checks.json` als unabhängige synthetische
   Prüfbeispiele einfügen. Erwartete Datensätze **2**, Pflichtspalten
   **order_id,status**. Konfiguration speichern.
3. Reparatur ausführen. Der Provider liefert einen Kandidaten; die App führt
   getrennte positive und negative Prüfinputs in begrenzten OS-Workern aus.
   Ein Kandidat allein schließt die Lücke noch nicht.
4. Import ausführen. Erst vollständiges Dataset-Readback und ein weiterer
   Ausführungslauf nach Aktivierung schließen die Lücke. Fehler bleiben sichtbar.
5. `measurements.supply` in einer neuen Session importieren: erwartete Datensätze
   **3**, Pflichtspalten **measurement_id,value**. Derselbe Parser soll passen;
   Werte und Feldzuordnung sind neu, der Modulhash bleibt gleich.

Eine bereits importierte Quelle ist unveränderlich; Änderungen brauchen eine neue
Session. Ein gleicher Dateisuffix beweist keine Eignung: Parsefehler, fehlende
Pflichtfelder oder abweichender Umfang verhindern erfolgreichen Import.

Der vorhandene Importplaner verwendet eine Quellprobe (bis zu 4.000 Zeichen) im
Prompt an den konfigurierten Provider. Der neue Zeitvergleich sendet ausschließlich
seinen generischen Regelvertrag. Providerwahl und freigegebene Quellen müssen zu
diesem Unterschied passen; die mitgelieferten Tests verwenden synthetische Daten.

## Reproduzierbare technische Checks

```bash
npm exec --yes --package=pnpm@10.18.3 -- pnpm --filter @koiforge/control-plane-api... test
npm exec --yes --package=pnpm@10.18.3 -- pnpm --filter @koiforge/control-plane-api... build
npm exec --yes --package=pnpm@10.18.3 -- pnpm --filter @koiforge/console-web build
cd packages/e2e-tests
./node_modules/.bin/playwright test --config playwright.freshness.config.ts
```

Browserchecks nutzen vorhandenes Chromium (`CHROMIUM_PATH` überschreibt
`/usr/bin/chromium`), Ports 3191/5191, temporäre Daten und einen ausdrücklich
geskripteten lokalen Testprovider. API-Tests starten für Wiederverwendung eigene
Node-Prozesse mit `KOIFORGE_GENERATION_DISABLED=1`. Ein verbotener Versuch wird
vor dem Provider protokolliert; es genügt nicht, fehlende Logzeilen zu zählen.

**Nachweisgrenze:** Diese Tests prüfen den echten API-/Worker-/Speicherpfad mit
geskripteten Providerantworten. Sie beweisen nicht, dass ein reales Modell ein
beliebiges neues Format zuverlässig implementiert. Ein solcher Modelllauf samt
fachlicher Quellabnahme steht noch aus. Beschaffungsfall A (K2), vollständiger
K3-Produktpfad, FireFlint-Consumer S1/S2 und produktive Authentifizierung/objektbezogene
Berechtigung P1 bleiben eigene Pakete. Der vorhandene Header-/Demo-Zugang und die
globale Datasetregistry sind kein abgenommener Mandantenbetrieb.

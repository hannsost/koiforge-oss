# Synthetische Bestellungsprüfung

Alle Bestellungen, Lieferanten und Fehler in diesem Ordner sind **synthetisch**.
Die Sollbefunde wurden anhand des Vertrags unabhängig vom Produktclassifier
festgelegt. Sie sind keine Kundenabnahme und kein Nachweis betrieblicher Wirkung.

## Demo einrichten

1. [bestellungen.csv](bestellungen.csv) und [lieferanten.csv](lieferanten.csv)
   vollständig importieren: UTF-8, Komma als Trenner, erste Zeile als Kopfzeile.
2. Im Fachmodell die Objektmenge „Bestellungen (synthetisch)“ mit `bestell_id`
   als ID-Feld bestätigen. „Lieferanten (synthetisch)“ verwendet `lieferant_id`
   als ID-Feld und `lieferant_name` als Anzeigename.
3. Die gerichtete Beziehung von Bestellungen zu Lieferanten bestätigen:
   `Bestellungen.lieferant_id` verweist auf `Lieferanten.lieferant_id`.
4. Für diese Beziehung einen Auftrag „Welche offenen Bestellungen sind zum
   23.09.2026 überfällig, und welche Angaben müssen wir klären?“ anlegen.
5. Das Feld `status` und folgende exakte Werte bestätigen: `Offen` und
   `Teilgeliefert` gelten als offen; `Erledigt` und `Storniert` als geschlossen.
   `zugesagter_liefertag` bedeutet den zugesagten Liefertag. Stichtag:
   **2026-09-23**. Nicht das aktuelle Tagesdatum übernehmen.
6. Ergebnis und Belege mit [expected.json](expected.json) vergleichen.
   Quellzeilen sind 1-basiert und zählen die Kopfzeile nicht mit.

Die Statuslisten enthalten keine stillen Voreinstellungen. In eigenen Exporten
darf eine der beiden Listen leer sein; zusammen muss mindestens ein echter
Status bestätigt werden. Jede Liste enthält höchstens 50 eindeutige Werte mit
höchstens 200 Zeichen pro Wert;
offene und geschlossene Liste dürfen sich nicht überschneiden. Leerzeichen und
Groß-/Kleinschreibung vorhandener Statuswerte werden nicht normalisiert.

## Erwartetes Ergebnis

| Befund | Zeilen |
| --- | ---: |
| Überfällig | 8 |
| Offen, derzeit nicht als überfällig bewertet | 16 |
| Abgeschlossen | 4 |
| Nicht beurteilbar | 12 |
| Insgesamt | 40 |

26 Zeilen benötigen mindestens eine Klärung. Das überschneidet sich mit den vier
Befundgruppen. Acht offene Zeilen haben keinen beurteilbaren Liefertag; sechs
eindeutig identifizierte Bestellungen haben ein Lieferantenproblem. Fehlende
oder doppelte Bestellidentitäten betreffen vier weitere Zeilen und verhindern
bereits die Bestellbeurteilung.

Die erste Ergebniszeile ist Bestellung `O-026` mit dem gültigen Schalttag
`2000-02-29`, danach `O-015` mit `2024-02-29`. Die gleiche Fälligkeit mehrerer
Bestellungen hält ihre ursprüngliche Quellreihenfolge ein. Anschließend folgen
nicht beurteilbare Zeilen, offene Zeilen mit Klärungsbedarf, die übrigen offenen
Zeilen und geschlossene Zeilen. Die vollständige erwartete Reihenfolge steht
in `prioritySourceRows`.

Besonders aufschlussreiche Fälle:

- Zeile 2 ist heute fällig und bleibt offen; sie ist noch nicht überfällig.
- Zeile 4 ist teilgeliefert und gemäß ausdrücklich bestätigter Regel überfällig.
- Zeilen 11 und 18 bleiben überfällig; unbekannter bzw. fehlender Lieferant
  kommt als Klärungsgrund hinzu.
- Zeile 19 bleibt abgeschlossen. Ihr ungültiges Datum erzeugt keine
  Terminaussage; der unbekannte Lieferant bleibt klärungsbedürftig.
- Zeile 10 bleibt wegen doppelter Bestell-ID nicht beurteilbar, obwohl der
  Quellstatus `Erledigt` lautet.
- `1900-02-29`, `2025-02-29`, `2026-02-30`, `2026-09-31`, Zeitstempel,
  unvollständige Schreibweise und ein Datum mit nachgestelltem Leerzeichen
  sind keine gültigen Liefertage in diesem Vertrag. Das technische Jahreslimit
  ist 1000 bis 9999.
- `offen`, ` Offen `, `0` und `__proto__` sind keine bestätigten offenen
  Statuswerte. Zeile 38 enthält absichtlich einen anweisungsartigen Text.
  Er ist ein unbekannter Quellstatus und darf keine Anweisung auslösen.

## Ohne bestätigte Terminbedeutung

Ein zweiter Lauf kann ausschließlich `status` bestätigen und die
Terminbedeutung `not_available` verwenden. Dann gibt es **24 offene, vier
geschlossene und zwölf nicht beurteilbare Zeilen; keine überfällige Zeile**.
Die Frist aller offenen Zeilen bleibt nicht beurteilbar. Die vorhandene
Datumsspalte allein berechtigt nicht zur Überfälligkeitsaussage. Der alternative
Vertrag steht unter `withoutDueDate` in `expected.json`.

## Datentypen und Nachweisgrenzen

CSV-Zellen bleiben Text: `001`, `1`, `0` und `false` sind vier verschiedene
Textschlüssel. Auch CSV-Anführungszeichen erzeugen keinen numerischen Datentyp.
Die Beispiele zeigen erhaltene führende Nullen und vorhandene Textwerte.
Den Unterschied zwischen der Zahl `1` und dem Text `"1"` sowie echten booleschen
Werten prüft separat [typed-cases.json](typed-cases.json) mit direkten
JSON-Importzeilen. Diese Datei ist keine CSV-Importanleitung.

Die Demo verändert kein ERP, bewertet keine künftig erwartete Lieferung und
weist keinen tatsächlich erfolgten Lieferverzug nach: „überfällig“ bedeutet
ausschließlich einen offenen bestätigten Status mit zugesagtem Liefertag vor
dem bestätigten Stichtag. Die Quelldaten selbst können veraltet oder fachlich
falsch sein. Die Belege halten Datenstand und Regel fest.

---
name: besprechung
description: Bereitet den aktuellen Sessionstand als vorlesefähiges Besprechungsdokument oder geführten Dialog auf. Use when the user wants to discuss, review, understand or decide the current plan, concept, architecture or implementation state, especially in a voice conversation.
---

# Besprechung

Rekonstruiere den aktuell relevanten Arbeitsstand der laufenden Session und bereite ihn für eine mündliche Besprechung auf. Dieser Skill ist weder eine allgemeine Zusammenfassung noch ein neues Architekturreview.

## Grenzen

- Verändere während der Besprechung keine Produktivdateien und führe keine bisherige Implementierungsaufgabe fort.
- Lies bereits behandelte Dateien nur, wenn der Sessionkontext für eine korrekte Rekonstruktion nicht ausreicht. Starte keine breite neue Codebase-Analyse.
- Eine Verständnismeldung ist keine fachliche Entscheidung. Eine fachliche Entscheidung ist noch kein Umsetzungsauftrag.
- Neue Überlegungen dürfen im Dialog aus Rückfragen entstehen. Kennzeichne sie als neuen Vorschlag statt als bereits beschlossenen Stand.
- Verwende standardmäßig die Sprache der laufenden Session.

## Relevanten Stand bestimmen

Priorisiere den zuletzt aktiv bearbeiteten Themenkomplex, den aktuellen Plan, Entwurf oder Implementierungsstand, offene Designentscheidungen und unmittelbar anstehende nächste Schritte. Gib kein chronologisches Chatprotokoll aus.

Unterscheide zuverlässig zwischen:

- feststehenden Anforderungen und getroffenen Entscheidungen,
- dem aktuellen Vorschlag oder implementierten Stand,
- verworfenen oder überholten Varianten,
- tatsächlich offenen Fragen.

Neuere verbindliche Aussagen haben Vorrang vor älteren Ideen. Frage nichts erneut, was bereits beantwortet wurde.

Ein optionaler Fokus ist ein Filter und Schwerpunkt. Ordne ihn knapp in das Gesamtsystem ein, behandle Nebenthemen aber nur, wenn sie für Verständnis oder Entscheidungen notwendig sind. Interpretiere auch Perspektiven wie "nur offene Entscheidungen" oder "Auswirkungen auf das Datenmodell" als Fokus.

## Fachlichen Modus wählen

Wähle intern einen der folgenden Modi:

1. **Beschreibung**, wenn der Nutzer einen bereits entwickelten Stand verstehen, prüfen oder einordnen soll.
2. **Fragen**, wenn die weitere Gestaltung wesentlich von wenigen Entscheidungen oder Präzisierungen des Nutzers abhängt.
3. **Gemischt**, wenn ein wesentlicher Stand stabil erklärt werden kann und zugleich wenige zentrale Entscheidungen offen sind.

Kleine Unsicherheiten rechtfertigen keinen Fragenkatalog. Eine Frage gehört nur hinein, wenn verschiedene plausible Antworten den Entwurf relevant verändern. Gib bei einer echten Frage nach Möglichkeit eine knappe Empfehlung mit Hauptgrund und gegebenenfalls der Bedingung für eine andere Wahl.

## Informationsaufbau

Baue jeden wesentlichen Punkt progressiv auf:

1. Gib zuerst Orientierung: Worum geht es, wo liegt der Punkt im Gesamtsystem und warum ist er jetzt relevant?
2. Erkläre danach den notwendigen fachlichen oder technischen Zusammenhang.
3. Verwende möglichst ein konkretes Beispiel, etwa einen Nutzerablauf, Datenfluss, Fehlerfall oder Zustand.
4. Halte technische Details, Randfälle, Abhängigkeiten und verworfene Alternativen für Vertiefungen oder Rückfragen bereit.

Die Kernaussage oder Entscheidungsfrage muss früh erkennbar sein. Vermeide Tabellen, Code-Dumps, lange Datei- und Identifierlisten, verschachtelte Aufzählungen und komprimierte Changelog-Sprache.

## Ausgabeform Dokument

Erzeuge ein eigenständig verständliches, direkt kopierbares Markdown-Dokument. Gib ausschließlich das Dokument aus, ohne Meta-Erklärung davor oder danach.

Geeigneter Aufbau:

```text
# Besprechung: <Thema>

## Orientierung
<aktueller Gesamtstand und Zweck>

## 1. <Themenbereich>
<Einordnung, aktueller Stand, Beispiel und bei Bedarf Detailkontext>

## Offene Entscheidungen
<nur im Fragen- oder Mischmodus; pro Frage Kontext, klare Frage, Empfehlung, Beispiel und Vertiefung>
```

Nutze natürliche Fließtextabsätze und sprechbare Überschriften. Lieber wenige gut vorbereitete Punkte als künstliche Vollständigkeit.

## Ausgabeform Dialog

Beginne mit einer kurzen Orientierung und einer sinnvollen Agenda. Behandle danach pro Antwort einen überschaubaren Hauptpunkt und stelle höchstens eine wesentliche Entscheidungsfrage gleichzeitig.

- Antworte natürlich und vorlesefähig in kurzen bis mittellangen Sätzen.
- Erkläre genug, damit der Beitrag ohne versteckten Kontext verständlich ist, aber lies nicht sofort den gesamten Detailkontext vor.
- Beantworte Rückfragen zuerst und kehre anschließend zum Gesprächsfaden zurück.
- Verstehe natürliche Steuerung wie "kürzer", "ein Beispiel", "technischer", "überspringen", "zurück" oder "was empfiehlst du?".
- Frage nicht nach jedem Absatz künstlich, ob du fortfahren sollst. Beende einen Turn an einer natürlichen Stelle.
- Spiegele eine eindeutige fachliche Entscheidung knapp und behandle sie danach als aktuellen Stand. Frage nur bei folgenreicher Mehrdeutigkeit nach.
- Fasse auf Wunsch oder am erkennbaren Abschluss die geklärten Entscheidungen, offenen Punkte und nächsten Schritte knapp zusammen.

Wenn der Nutzer während des Dialogs eindeutig die Umsetzung verlangt, bestätige den Wechsel aus der Besprechung. Setze die Implementierung erst als separaten Arbeitsauftrag fort.

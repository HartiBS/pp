# pp – Agile-Projektverwaltung

Dieses Repository enthält ein Werkzeug zur Verwaltung agiler Projekte
(Backlog, Sprints, Boards).

## Status

Projektgerüst – die Anwendung wird iterativ aufgebaut. Der aktuelle
Projektfortschritt und die offenen Aufgaben sind unter
[docs/agile-process.md](docs/agile-process.md) und im Backlog dokumentiert.

## Struktur

```text
src/    Quellcode
tests/  Testcode
docs/   Projektdokumentation (Prozess, Architektur, Entscheidungen)
```

## Entwicklung

Python 3, nur Standardbibliothek – Entscheidung siehe
[docs/adr-001-tech-stack.md](docs/adr-001-tech-stack.md).

```bash
# Tests
python3 -m unittest discover -s tests

# CLI (aus dem Repo-Root, PYTHONPATH auf src/)
PYTHONPATH=src python3 -m pp.cli project add p1 "Meine Projekt"
PYTHONPATH=src python3 -m pp.cli item add p1 i1 "Erster Eintrag" --priority hoch
PYTHONPATH=src python3 -m pp.cli item move p1 i1 in_arbeit
PYTHONPATH=src python3 -m pp.cli board p1

# HTML5-Board im Browser (http://localhost:8000)
PYTHONPATH=src python3 -m pp.cli serve
```

Daten liegen standardmäßig in `projects.json` (`--db` zum Überschreiben).

Die Webapp unter `serve` unterstützt die komplette Verwaltung im Browser:
Projekte anlegen, Backlog-Einträge mit Priorität anlegen, Status per
Drag & Drop ändern und Einträge löschen.

## Agiler Prozess

Das Projekt wird in Sprints entwickelt:

1. Backlog pflegen (`docs/backlog.md`)
2. Sprint planen und im Board verfolgen (`docs/board.md`)
3. Nach jedem Sprint Review und Retrospektive festhalten
   (`docs/retros.md`)

## Lizenz

GPL-3.0 – siehe [LICENSE](LICENSE).

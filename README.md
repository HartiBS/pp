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

## Authentifizierung per GitHub-Login (optional)

Der Boardserver kann Zugriff nur nach GitHub-OAuth-Login erlauben.
Ohne Konfiguration bleibt der lokale Modus ohne Login aktiv.

1. GitHub-OAuth-App anlegen: Settings → Developer settings → OAuth Apps,
   Callback-URL `http://localhost:8000/auth/callback`
2. Server starten:

```bash
export GITHUB_CLIENT_ID=<id>
export GITHUB_CLIENT_SECRET=<secret>
# optional: Zugriff einschränken
export GITHUB_ALLOWED_USERS=alice,bob

PYTHONPATH=src python3 -m pp.cli serve --base-url http://localhost:8000
```

Besuchende werden auf GitHub angemeldet; danach gilt eine Session (12 h,
Cookie `HttpOnly; SameSite=Lax`). Ohne `GITHUB_ALLOWED_USERS` ist jeder
GitHub-Nutzer zugelassen. Abmelden über den Link in der Kopfzeile.

## GitLab-Sync

Jedes pp-Projekt wird als eigenes GitLab-Repository in einer Gruppe
synchronisiert, jeder Backlog-Eintrag als Issue (Work Item) darin:

```bash
export GITLAB_URL=https://gitlab.example.com   # optional, Default gitlab.com
export GITLAB_GROUP=meine-agile-gruppe          # Namespace für die Projekt-Repos
export GITLAB_TOKEN=<personal access token>     # scope: api

PYTHONPATH=src python3 -m pp.cli sync          # alle Projekte
PYTHONPATH=src python3 -m pp.cli sync p1        # nur Projekt p1
```

Mapping: Repo-Name = Projekt-ID, Issue-Titel = `[<item-id>] <Titel>`,
Status als Label (`status:offen` … `status:fertig`), Priorität als Label
(`prio:hoch` …). Einträge mit Status `fertig` schließen das Issue.
Der Sync ist idempotent – mehrfaches Ausführen erzeugt keine Dubletten.

Alternativ direkt im Browser (Button **↻ Sync** in der Kopfzeile): Die
GitLab-Zugangsdaten werden im Dialog **GitLab** abgelegt und nur im
Browser (localStorage) gespeichert. Sie werden ausschließlich für einen
Sync-Aufruf an den lokalen Server übertragen.

## Agiler Prozess

Das Projekt wird in Sprints entwickelt:

1. Backlog pflegen (`docs/backlog.md`)
2. Sprint planen und im Board verfolgen (`docs/board.md`)
3. Nach jedem Sprint Review und Retrospektive festhalten
   (`docs/retros.md`)

## Lizenz

GPL-3.0 – siehe [LICENSE](LICENSE).

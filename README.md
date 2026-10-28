# PP – Projektverwaltung

Webapplikation zur Verwaltung von Softwareprojekten.

**Stack:** Node.js + Express + PostgreSQL + Vanilla JS, Apache als Reverse Proxy.

## Voraussetzungen

- Node.js 20+
- PostgreSQL 16+ (oder Docker)
- Apache (nur für Produktivbetrieb als Reverse Proxy)

## Lokale Entwicklung (ohne Docker)

```bash
cp .env.example .env
# .env anpassen (DATABASE_URL, SESSION_SECRET)

npm install
npm run migrate   # Datenbank-Schema anlegen
npm run dev       # Server mit Auto-Reload starten
```

App erreichbar unter: http://localhost:3000

## Lokale Entwicklung (mit Docker)

```bash
docker compose up --build
```

App erreichbar unter: http://localhost:3000

Alternativ aus dem `docker/`-Verzeichnis:

```bash
cd docker
docker compose up --build
```

## Produktivbetrieb mit Apache

1. Node-App starten (z. B. via systemd), läuft auf `localhost:3000`
2. Apache-Module aktivieren:
   ```bash
   sudo a2enmod proxy proxy_http
   ```
3. `apache/pp.conf` nach `/etc/apache2/sites-available/pp.conf` kopieren und aktivieren:
   ```bash
   sudo a2ensite pp
   sudo systemctl reload apache2
   ```

## API-Übersicht

| Methode | Pfad | Beschreibung |
|---|---|---|
| POST | `/api/auth/register` | Registrieren (Vorname, Nachname, Benutzername, E-Mail, Passwort) |
| POST | `/api/auth/login` | Einloggen (mit Benutzername **oder** E-Mail + Passwort) |
| POST | `/api/auth/logout` | Abmelden |
| GET | `/api/auth/me` | Aktueller Benutzer |
| PUT | `/api/auth/profile` | Eigenes Profil bearbeiten (Vorname, Nachname, Benutzername, E-Mail, Passwort) |
| GET | `/api/admin/users` | Alle Benutzer (nur Admin) |
| POST | `/api/admin/users` | Benutzer anlegen inkl. Benutzername (nur Admin) |
| PUT | `/api/admin/users/:id` | Benutzer bearbeiten (inkl. Benutzername) / aktivieren / deaktivieren (nur Admin) |
| DELETE | `/api/admin/users/:id` | Benutzer löschen (nur Admin) |
| GET | `/api/admin/roles` | Verfügbare Rollen & Berechtigungen |
| GET | `/api/admin/permissions-matrix` | Berechtigungs-Matrix (Rolle × Berechtigung) |
| PUT | `/api/admin/permissions-matrix/:role` | Berechtigungen einer Rolle setzen |
| PUT | `/api/admin/users/:id` | `roles` (Array) statt einzelner `role` — mehrere Rollen pro User möglich |
| GET | `/api/projects` | Projekte des Benutzers |
| POST | `/api/projects` | Projekt anlegen |
| GET | `/api/projects/:id` | Projekt inkl. Tasks (Filter: `?type=&status=&label=&epic_only=true`) |
| GET | `/api/projects/:id/dashboard` | KPIs, Burndown, Aktivität, Fälligkeiten |
| PUT | `/api/projects/:id` | Projekt aktualisieren |
| DELETE | `/api/projects/:id` | Projekt löschen |
| POST | `/api/projects/:id/tasks` | Task anlegen |
| PUT | `/api/projects/:id/tasks/:taskId` | Task aktualisieren |
| DELETE | `/api/projects/:id/tasks/:taskId` | Task löschen |
| GET | `/api/projects/:id/members` | Projektmitglieder |
| POST | `/api/projects/:id/members` | Mitglied hinzufügen/aktualisieren |
| DELETE | `/api/projects/:id/members/:userId` | Mitglied entfernen |
| GET | `/api/gitlab/settings` | GitLab-Konfiguration (nur Admin) |
| PUT | `/api/gitlab/settings` | GitLab-URL & Token speichern (nur Admin) |
| POST | `/api/gitlab/settings/test` | GitLab-Verbindung testen (nur Admin) |
| POST | `/api/gitlab/projects/:id/sync` | GitLab-Issues synchronisieren |
| GET | `/api/gitlab/projects/:id/issues` | Synchronisierte GitLab-Issues |
| POST | `/api/gitlab/projects/:id/issues` | Issue in GitLab anlegen |
| PUT | `/api/gitlab/projects/:id/issues/:iid` | Issue bearbeiten / schließen / wiedereröffnen |
| GET | `/api/gitlab/projects/:id/issues/:iid/comments` | Kommentare laden |
| POST | `/api/gitlab/projects/:id/issues/:iid/comments` | Kommentar hinzufügen |
| PUT | `/api/gitlab/projects/:id/issues/:iid/assignee` | GitLab-Issue zuweisen |
| GET | `/api/gitlab/projects-list?search=` | GitLab-Projekte & Gruppen suchen |
| GET | `/api/gitlab/projects/:id/milestones` | Meilensteine des Projekts |
| POST | `/api/gitlab/projects/:id/milestones/sync` | GitLab-Meilensteine synchronisieren |
| GET | `/api/gitlab/projects/:id/gitlab-users` | GitLab-Mitglieder des Projekts |
| GET | `/api/notifications` | Eigene Benachrichtigungen (+ unread-Count) |
| POST | `/api/notifications/read-all` | Alle als gelesen markieren |
| POST | `/api/notifications/:id/read` | Eine als gelesen markieren |

## Rollen

| Rolle | Rechte |
|---|---|
| `admin` | Alles inkl. Benutzerverwaltung |
| `projektmanager` | Projekte verwalten |
| `entwickler` | Tasks bearbeiten |
| `beobachter` | Nur Lesen |

Der erste registrierte Benutzer wird automatisch **Admin**. Rollen können in der Benutzerverwaltung (nur sichtbar für Admins) geändert werden.

### Mehrere Rollen pro Benutzer (#55) & Berechtigungs-Matrix (#39, #40)

- Ein Benutzer kann **mehrere globale Rollen** gleichzeitig haben (`user_roles`, N:M). Die **effektive Rolle** ist die stärkste (Priorität: `admin` > `projektmanager` > `entwickler` > `beobachter`).
- In der **Benutzerverwaltung** gibt es zwei Checkbox-Matrizen:
  - **Rollen-Matrix** (User × Rollen, #40 / US-22): Rollen direkt per Checkbox zuweisen/entziehen
  - **Berechtigungs-Matrix** (Rolle × Berechtigung, #39 / US-21): Welche Berechtigungen hat welche Rolle — in der DB änderbar (`role_permissions`)
- Die Rolle `admin` hat immer alle Rechte (Checkboxen in der Matrix deaktiviert).
- Selbstschutz: Die eigene Admin-Rolle kann nicht entzogen und mindestens eine Rolle muss verbleiben.

### Projektbezogene Rollen (Epic 2)

Neben der globalen Rolle gibt es **projektbezogene Rollen** (`project_members`):

| Projekt-Rolle | Rechte im Projekt |
|---|---|
| **Projektmanager** (Owner + zugewiesen) | Projekt bearbeiten/löschen, Mitglieder verwalten, Tasks anlegen/bearbeiten/löschen |
| **Entwickler** | Tasks anlegen und bearbeiten |
| **Beobachter** | Nur Lesen (Tasks werden als Badges statt Dropdown angezeigt) |

Der **globale Admin** hat in jedem Projekt alle Rechte. Der Projekt-Owner ist implizit Projektmanager und kann nicht entfernt werden. Mitglieder werden in der Projekt-Detailansicht verwaltet.

## Ansichten & Filter (Epic 4)

In der Projekt-Detailansicht gibt es vier Tabs:

| Tab | Inhalt |
|---|---|
| **Dashboard** (US-11) | KPIs (offen/erledigt/in Arbeit/überfällig/Epics/Bugs), Burndown-Chart (14 Tage), Verteilung nach Status & Typ, letzte Aktivität, anstehende Fälligkeiten |
| **Liste** (US-14, US-15) | Alle Issues mit Typ-Badge, Labels, Fälligkeitsdatum; Filter-Bar: Typ, Status, Label, „Nur Epics" |
| **Board** (US-13) | Kanban-Board mit 4 Status-Spalten (To Do / In Progress / Review / Done); Drag & Drop zum Statuswechsel (ab Entwickler) |
| **Timeline** (US-12) | Gantt-ähnliche Zeitleiste: Balken von Erstellung bis Fälligkeitsdatum, farbcodiert nach Status; Issues ohne Datum als Liste darunter |

Issues haben einen **Typ** (`epic`, `user_story`, `task`, `bug`), **Labels** (kommagetrennt) und ein optionales **Fälligkeitsdatum**. Epics können über `epic_id` gruppiert werden.

## Projektverwaltung & Benachrichtigungen (Epic 5)

**US-16: GitLab-Projekte/Gruppen verwalten** — Projektmanager/Admin können in der Projekt-Detailansicht über „Aus GitLab wählen" verfügbare GitLab-Projekte und Gruppen suchen (`GET /api/gitlab/projects-list`) und ein GitLab-Projekt mit dem App-Projekt verknüpfen.

**US-17: Meilensteine & Sprints synchronisieren** — GitLab-Meilensteine werden per „Synchronisieren" gespiegelt (`gitlab_milestones`) und stehen im Task-Formular als Auswahl zur Verfügung (`tasks.milestone_id`).

**US-18: Issue-Zuweisung** — Tasks haben ein `assignee_id` (Default: Ersteller). Beim Anlegen und beim Ändern der Zuweisung wird der neue Bearbeiter benachrichtigt. Für GitLab-Issues: `PUT /api/gitlab/projects/:id/issues/:iid/assignee`.

**US-19: Benachrichtigungen** — In-App-Glocke 🔔 im Header mit Badge (ungelesene Anzahl, Polling alle 60 s). Auslöser:
- **Zuweisung** (`assigned`) — Task wird einem anderen Mitglied zugewiesen
- **Statusänderung** (`status_change`) — Status eines zugewiesenen Tasks ändert sich
- **Kommentar** (`comment`) — neuer Kommentar an einem GitLab-Issue des Projekts (alle Projektmitglieder außer dem Autor)

## GitLab-Integration (Epic 3)

Die App kann Issues direkt mit einer GitLab-Instanz synchronisieren:

1. **Admin** hinterlegt in der Benutzerverwaltung unter „GitLab-Verbindung" die GitLab-URL und den Access Token eines **Service-Accounts** (Bot-User mit `api`-Scope). Optional kann der Service-Account-Benutzername angegeben werden — dann sendet die App zusätzlich den Header `X-GitLab-Username` (Impersonation, falls auf dem Token aktiviert). „Verbindung testen" zeigt an, als welcher GitLab-User die Verbindung besteht.
2. In der **Projekt-Detailansicht** wird die GitLab-Projekt-ID verknüpft (nur Projektmanager/Admin)
3. Über **„Synchronisieren"** werden alle Issues des GitLab-Projekts geladen und lokal gespiegelt (`gitlab_issues`)
4. Neue Issues können direkt aus der App in GitLab angelegt werden; bestehende lassen sich **bearbeiten, kommentieren, schließen und wiedereröffnen**

Rechte: Erstellen/Bearbeiten/Kommentieren erfordert mindestens die projektbezogene Rolle **Entwickler**; Lesen genügt **Beobachter**. Der GitLab-Token wird nur serverseitig verwendet und nie an das Frontend ausgeliefert.

## Sicherheit

- **CSRF-Schutz**: Alle zustandsändernden API-Requests (`POST`/`PUT`/`DELETE`/`PATCH`) erfordern ein gültiges CSRF-Token. Das Token wird pro Session generiert (`src/middleware/csrf.js`), über `GET /api/csrf-token` ausgeliefert und vom Frontend im Header `X-CSRF-Token` mitgesendet (Alternativ: `_csrf` im Body). Der Vergleich erfolgt timing-sicher (`crypto.timingSafeEqual`). `GET`/`HEAD`/`OPTIONS` sind ausgenommen.
- Session-Cookie: `httpOnly`, `sameSite: lax`
- Passwörter: bcrypt (Cost 10)
- GitLab-Token: nur serverseitig in der DB, nie an das Frontend ausgeliefert
- GitLab-Synchronisation: Beim Öffnen eines verknüpften Projekts werden GitLab-Issues automatisch synchronisiert (#56). Beim Anlegen eines Tasks kann „Auch in GitLab anlegen" gewählt werden; Änderungen an verknüpften Tasks (Titel, Beschreibung, Status `done` → GitLab `closed`) werden automatisch nach GitLab gepusht (#57). Fehler beim Push werden geloggt, blockieren aber nicht die lokale Speicherung.
- SQL: ausschließlich parametrisierte Queries

## Projektstruktur

```
├── src/
│   ├── config/       # Datenbank-Verbindung
│   ├── db/           # Migrations-Runner
│   ├── middleware/   # Auth-Middleware
│   └── routes/       # API-Routen (auth, projects)
├── public/           # Statisches Frontend (HTML/CSS/JS)
├── db/migrations/    # SQL-Migrationen
├── apache/           # Apache Reverse-Proxy Config
└── docker/           # Docker Compose + Dockerfile
```

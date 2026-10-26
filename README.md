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
cd docker
docker compose up --build
```

App erreichbar unter: http://localhost:3000

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
| GET | `/api/admin/roles` | Verfügbare Rollen |
| GET | `/api/projects` | Projekte des Benutzers |
| POST | `/api/projects` | Projekt anlegen |
| GET | `/api/projects/:id` | Projekt inkl. Tasks |
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

## Rollen

| Rolle | Rechte |
|---|---|
| `admin` | Alles inkl. Benutzerverwaltung |
| `projektmanager` | Projekte verwalten |
| `entwickler` | Tasks bearbeiten |
| `beobachter` | Nur Lesen |

Der erste registrierte Benutzer wird automatisch **Admin**. Rollen können in der Benutzerverwaltung (nur sichtbar für Admins) geändert werden.

### Projektbezogene Rollen (Epic 2)

Neben der globalen Rolle gibt es **projektbezogene Rollen** (`project_members`):

| Projekt-Rolle | Rechte im Projekt |
|---|---|
| **Projektmanager** (Owner + zugewiesen) | Projekt bearbeiten/löschen, Mitglieder verwalten, Tasks anlegen/bearbeiten/löschen |
| **Entwickler** | Tasks anlegen und bearbeiten |
| **Beobachter** | Nur Lesen (Tasks werden als Badges statt Dropdown angezeigt) |

Der **globale Admin** hat in jedem Projekt alle Rechte. Der Projekt-Owner ist implizit Projektmanager und kann nicht entfernt werden. Mitglieder werden in der Projekt-Detailansicht verwaltet.

## GitLab-Integration (Epic 3)

Die App kann Issues direkt mit einer GitLab-Instanz synchronisieren:

1. **Admin** hinterlegt in der Benutzerverwaltung unter „GitLab-Verbindung" die GitLab-URL und ein Access Token (Personal/Project/Group Token mit `api`-Scope)
2. In der **Projekt-Detailansicht** wird die GitLab-Projekt-ID verknüpft (nur Projektmanager/Admin)
3. Über **„Synchronisieren"** werden alle Issues des GitLab-Projekts geladen und lokal gespiegelt (`gitlab_issues`)
4. Neue Issues können direkt aus der App in GitLab angelegt werden; bestehende lassen sich **bearbeiten, kommentieren, schließen und wiedereröffnen**

Rechte: Erstellen/Bearbeiten/Kommentieren erfordert mindestens die projektbezogene Rolle **Entwickler**; Lesen genügt **Beobachter**. Der GitLab-Token wird nur serverseitig verwendet und nie an das Frontend ausgeliefert.

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

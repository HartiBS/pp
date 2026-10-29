# Security Policy

## Unterstützte Versionen

Sicherheitsupdates werden für die aktuelle Hauptversion (Branch `main`) bereitgestellt.

| Version | Unterstützt |
|---------|-------------|
| main (aktuell) | ✅ |
| Ältere Releases | ❌ |

## Sicherheitslücke melden

Bitte melde Sicherheitslücken **nicht** öffentlich über Issues oder Pull Requests.

### Meldeweg

1. **E-Mail:** Schreibe eine E-Mail an den Repository-Maintainer (siehe GitHub-Profil des Owners) mit dem Betreff `Sicherheitsmeldung: PP`.
2. **GitHub Private Vulnerability Reporting:** Alternativ kannst du über den Reiter **Security → Advisories → Report a vulnerability** eine private Meldung erstellen.

### Was die Meldung enthalten sollte

- Beschreibung der Schwachstelle und der betroffenen Komponente (z. B. API-Endpunkt, Datei, Abhängigkeit)
- Schritte zur Reproduktion (Proof of Concept, falls vorhanden)
- Einschätzung der Auswirkungen (z. B. Datenabfluss, Rechteausweitung, DoS)
- Falls bekannt: ein Vorschlag zur Behebung

### Ablauf nach der Meldung

- **Bestätigung** innerhalb von 72 Stunden
- **Erste Einschätzung** (Schweregrad, Betroffenheit) innerhalb von 7 Tagen
- Behebung als privates Security-Advisory mit anschließendem öffentlichen Fix und Dank im Changelog
- Bei kritischen Lücken: zeitnaher Patch-Release außerhalb des regulären Rhythmus

## Umfang (Scope)

In Scope:

- Webanwendung (Node.js/Express, `src/`, `public/`)
- API-Endpunkte unter `/api/*` (Authentifizierung, Autorisierung, Injection, XSS, CSRF)
- Datenbankzugriff und Migrationen (`db/`)
- Docker-Setup und Apache-Konfiguration (`docker/`, `apache/`)
- CI/CD-Workflows (`.github/workflows/`)
- Abhängigkeiten aus `package.json` (bekannte CVEs)

Out of Scope:

- Schwachstellen in eingesetzten Dritt-Systemen ohne Bezug zum Projekt (z. B. Betriebssystem des Nutzers)
- Fehlkonfigurationen auf produktiven Systemen, die nicht aus diesem Repository hervorgehen
- Social Engineering / Phishing gegen Projektmitglieder

## Bekannte Sicherheitsmaßnahmen

- Passwörter werden gehasht gespeichert (bcrypt)
- Session-basierte Authentifizierung mit `SESSION_SECRET` aus der Umgebung
- Secrets und Zugangsdaten werden ausschließlich über `.env` bzw. Umgebungsvariablen konfiguriert und sind via `.gitignore`/`.dockerignore` vom Repository ausgeschlossen
- Regelmäßige automatisierte Scans: CodeQL (`.github/workflows/codeql.yml`) und CI-Tests
- Dependabot hält Abhängigkeiten aktuell (`.github/dependabot.yml`)

## Hinweise für Melder

- Bitte gib uns ausreichend Zeit zur Behebung, bevor du Details öffentlich machst (Koordinierte Veröffentlichung, in der Regel 90 Tage nach Meldung).
- Wir danken allen Meldern, die verantwortungsvoll handeln.

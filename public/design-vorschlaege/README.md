# 🎨 Designvorschläge – Klickdummys

Interaktive HTML-Prototypen für die PP Projektverwaltung. Jeder Vorschlag zeigt **alle 5 Ansichten** des aktuellen Funktionsumfangs.

## Zugriff

Sobald der Server läuft:

| Seite | URL |
|-------|-----|
| **Übersicht** | `http://localhost:3000/design-vorschlaege/` |
| Vorschlag A: Modern Dashboard | `http://localhost:3000/design-vorschlaege/vorschlag-a-modern.html` |
| Vorschlag B: Dark Professional ⭐ *angewendet* | `http://localhost:3000/design-vorschlaege/vorschlag-b-dark.html` |
| Vorschlag C: Warm Minimal | `http://localhost:3000/design-vorschlaege/vorschlag-c-minimal.html` |

> **Docker:** `cd docker && docker-compose restart app`

## Ansichten pro Dummy

Jeder Klickdummy enthält unten eine Navigationsleiste mit 5 Ansichten:

1. 🔑 **Login / Registrieren** – Auth-Card mit Tabs
2. 📊 **Dashboard** – Projektliste + "Neues Projekt"-Formular
3. 📋 **Projektdetail** – Task-Liste mit Status-Badges
4. 👤 **Profil** – Name, E-Mail, Passwort ändern
5. 🛠 **Admin** – Benutzerverwaltung als Tabelle

> **Vorschlag B** hat zusätzlich einen **☀️/🌙 Theme-Toggle** in der Topbar (Dark ↔ Light Mode).

## Direkt im Browser öffnen (ohne Server)

- `public/design-vorschlaege/index.html`
- `public/design-vorschlaege/vorschlag-a-modern.html`
- `public/design-vorschlaege/vorschlag-b-dark.html`
- `public/design-vorschlaege/vorschlag-c-minimal.html`

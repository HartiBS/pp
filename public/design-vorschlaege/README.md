# 🎨 Designvorschläge – Klickdummys

Diese Dateien sind Design-Prototypen für die PP Projektverwaltung.

## Zugriff

Sobald der Server läuft, erreichst du die Vorschläge unter:

| Seite | URL |
|-------|-----|
| **Übersicht** (alle 3 Vorschläge) | `http://localhost:3000/design-vorschlaege/` |
| Vorschlag A: Modern Dashboard | `http://localhost:3000/design-vorschlaege/vorschlag-a-modern.html` |
| Vorschlag B: Dark Professional | `http://localhost:3000/design-vorschlaege/vorschlag-b-dark.html` |
| Vorschlag C: Warm Minimal | `http://localhost:3000/design-vorschlaege/vorschlag-c-minimal.html` |

> **Hinweis:** Falls der Server in Docker läuft, starte ihn neu damit die neuen Dateien geladen werden:
> ```bash
> cd docker && docker-compose restart app
> ```

## Direkt im Browser öffnen (ohne Server)

Du kannst die HTML-Dateien auch direkt im Browser öffnen:
- `public/design-vorschlaege/index.html`
- `public/design-vorschlaege/vorschlag-a-modern.html`
- `public/design-vorschlaege/vorschlag-b-dark.html`
- `public/design-vorschlaege/vorschlag-c-minimal.html`

## Inhalt

Jeder Vorschlag zeigt 3 Ansichten als Klickdummy:
1. **Login/Registrierung**
2. **Dashboard** (Projektübersicht)
3. **Projektdetail** (Task-Liste)

Unten rechts gibt es eine Navigationsleiste zum Umschalten.

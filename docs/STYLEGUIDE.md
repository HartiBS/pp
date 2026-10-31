# PP Styleguide

Dokumentation aller UI-Komponenten und Design-Tokens der Applikation.
**Alle Layout-Änderungen werden hier vorgegeben** – Implementierung in `public/css/style.css`.

## 1. Design-Tokens (CSS-Variablen)

Alle Farben, Abstände und Schatten werden zentral in `:root` definiert
(`public/css/style.css:1`). Niemals harte Farbwerte in Komponenten verwenden.

### Farbpalette

| Token | Dark (Default) | Light (`body.light`) | Verwendung |
|---|---|---|---|
| `--bg` | `#0b1120` | `#f0f4f8` | Seitenhintergrund |
| `--bg-elevated` / `--bg-card` | `#111a2e` | `#ffffff` | Karten, Dropdowns |
| `--border` | `#1e293b` | `#e2e8f0` | Trennlinien, Button-Rahmen |
| `--border-hover` | `#334155` | `#cbd5e1` | Hover-Rahmen |
| `--text` | `#e2e8f0` | `#1e293b` | Haupttext |
| `--text-muted` | `#64748b` | `#64748b` | Sekundärtext |
| `--text-faint` | `#475569` | `#94a3b8` | Dezentester Text (Footer) |
| `--accent` | `#0d9488` | `#0d9488` | Primärfarbe (Buttons, Links) |
| `--accent-hover` | `#0f766e` | `#0f766e` | Hover Primärfarbe |
| `--accent-light` | `#2dd4bf` | `#0d9488` | Akzent auf dunklem Grund |
| `--danger` | `#ef4444` | `#dc2626` | Fehler, Löschen |
| `--input-bg` | `#0b1120` | `#f8fafc` | Eingabefelder |
| `--shadow` | `rgba(0,0,0,0.3)` | `rgba(0,0,0,0.06)` | Kartenschatten |
| `--success` | `#22c55e` | `#16a34a` | Erfolgsmeldungen (`.msg-success`) |

### Badge-Farben (Priorität)

| Priorität | Tokens | Klasse |
|---|---|---|
| `critical` (Kritisch) | `--badge-prio-critical-bg/-text` | `.badge-priority-critical` |
| `high` (Hoch) | `--badge-prio-high-bg/-text` | `.badge-priority-high` |
| `normal` (Mittel) | `--badge-prio-normal-bg/-text` | `.badge-priority-normal` |
| `low` (Niedrig) | `--badge-prio-low-bg/-text` | `.badge-priority-low` |

### Badge-Farben (Status & Priorität)

| Status | Tokens | Klasse |
|---|---|---|
| `todo` | `--badge-todo-bg/-text` | `.badge-todo` |
| `in_progress` | `--badge-progress-bg/-text` | `.badge-in_progress` |
| `review` | `--badge-review-bg/-text` | `.badge-review` |
| `done` | `--badge-done-bg/-text` | `.badge-done` |
| `active` (Projekt) | `--badge-active-bg/-text` | `.badge-active` |
| `planning` (Projekt) | `--badge-planning-bg/-text` | `.badge-planning` |

Prioritäten: `.badge-priority-low/normal/high/critical` (Farben siehe Prioritäts-Tabelle oben; Mapping der deutschen Begriffe: Kritisch = `critical`, Hoch = `high`, Mittel = `normal`, Niedrig = `low`).

## 2. Typografie

- **Schriftart:** `Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`
- **Überschriften:** `main h2` = 1.5rem/700, `main h3` kleiner, `letter-spacing: -0.3px`
- **Fließtext:** Standardgröße, `--text`
- **Kleine Texte:** `small` / `.kpi-label` in `--text-muted`, 0.8–0.875rem

## 3. Layout

- `main`: `max-width: 1000px`, zentriert, `padding: 2rem`
- `.topbar`: fixe Kopfleiste mit Logo links, Navigation rechts
- `.app-footer`: Fußzeile (Version links unten, `--text-faint`, 0.8rem)
- Responsive: Breakpoints bei `max-width: 800px` und `max-width: 640px`

## 4. Komponenten

### Buttons

| Klasse | Verwendung |
|---|---|
| `button` (Default) | Primäraktion, Akzent-Hintergrund, weißer Text, `border-radius: 6px`, `padding: 0.6rem 1.3rem` |
| `.btn-secondary` | Sekundäraktion, transparent mit `--border`-Rahmen |
| `.btn-small` | Klein in Tabellen/Listen (z. B. Bearbeiten/Löschen) |
| `#logout-btn` | Kompakt in der Topbar, danger-Hover |
| `#back-btn` / `.…-back-btn` | Zurück-Navigation, uppercase, klein |

### Formulare

- `form`: Spalte mit `gap: 0.75rem`
- `input, textarea, select`: `--input-bg`, 1px `--border`, `border-radius: 4px`; Fokus = `--accent`
- `label`: Flex-Spalte mit kleinem Gap

### Badges

`.badge` + Statusklasse (siehe Tabelle oben). Immer `text-transform: uppercase`, 0.7rem, 700.

### Listen & Karten

- `.dash-list`: Standardliste (`list-style: none`, Spalte, `gap: 0.5rem`), `li` als Karte mit `--border`
- `#project-list, #task-list`: Projekt-/Task-Liste, Hover = `--accent`-Rahmen
- `.board` / `.board-col` / `.board-card`: Kanban-Board
- `.kpi-grid` / `.kpi-card`: Dashboard-KPIs

### Tabs

`.view-tabs` + `.view-tab` (`.active` = Akzent-Underline/-Text), z. B. Admin- und Task-Detail-Ansicht.

### Tabellen

`.matrix-table`, `#user-table`, `#admin-project-table`, `#custom-field-table`: Header mit `--border`, Hover-Zeile, Checkbox-Zellen zentriert.

### Sonstiges

- `.error`: Fehlermeldungen in `--danger`
- `.msg-success`: Erfolgsmeldungen in `--success`
- `.notif-dropdown` / `.notif-item`: Benachrichtigungs-Dropdown (`.unread` akzentuiert)
- `#sync-indicator`: Sync-Statusanzeige
- `.theme-toggle`: Dark/Light-Umschalter in der Topbar (Theme via `body.light` + `localStorage` `pp-theme`)

### Issue-Erfassung / Formular-Pattern

Verbindliche Klassen für GitHub-analoge Eingabeformulare mit projektbezogenen Zusatzfeldern (2-Spalten-Layout: Details links, Metadaten rechts):

| Klasse | Verwendung |
|---|---|
| `.card-grid` | Grid-Container: 1 Spalte mobil, 3 Spalten ab 1024px; `.card-span-2` spannt 2 Spalten |
| `.card` / `.card-header` / `.card-title` / `.card-content` | Karte mit Titelbereich und Inhalt (`gap: 1rem`) |
| `.form-grid` | 2-spaltiges Grid für projektbezogene Pflichtfelder (1 Spalte unter 640px) |
| `.field` + `label` | Feld mit kleinem Label (0.75rem, 500, `--text-muted`) |
| `.separator` | Abschnitts-Trenner (`<hr>`) |
| `.section-label` | Abschnitts-Überschrift (uppercase, tracking-wide) |
| `.label-pill` / `.label-pill.selected` | Umschaltbare Label-Pills (ausgewählt: invertiert) |
| `.assignee-row` + `.avatar` | Assignee-Zeile mit rundem Initial-Avatar (24px) |
| `.issue-card` / `.issue-card-head` / `.issue-title` / `.issue-number` / `.issue-badges` | Issue-Karte in der Liste (Titel + `#{number}`, Badge-Reihe, rechts Status + Avatar) |
| `.btn-block` | Button auf volle Breite (z. B. Submit unter der Metadaten-Spalte) |

Prioritäts-Badges in Issue-Karten verwenden die Prioritäts-Tokens (Kritisch = `--badge-prio-critical-*`, Hoch = `--badge-prio-high-*`, Mittel = `--badge-prio-normal-*`, Niedrig = `--badge-prio-low-*`).

### Issue-Detail-Ansicht (Tracker-Issue, z. B. GitLab)

Die Detailansicht eines externen Issues (`#gitlab-issue-view`) folgt demselben Card-Layout: `.card-grid` mit einer `.card.card-span-2` (Titel + Beschreibung + Feld-Grid) links und einer `.card` (Metadaten: Labels als `.label-pill.selected`, Bearbeiter als `.assignee-row` + `.avatar`, Custom Fields, Aktions-Buttons als `.btn-block`) rechts. Die angezeigten Felder kommen aus dem Tracker-Mapping (Pull-Richtung) plus den für das Projekt aktivierten Custom Fields und werden per `.form-grid` bzw. `.field` gerendert.

## 5. Regeln für Änderungen

1. **Nie** harte Hex-Werte in Komponenten – immer Token aus `:root`.
2. Neue Komponenten grundsätzlich mit bestehenden Klassen bauen; nur wenn nötig, neue Klasse in `style.css` ergänzen **und hier dokumentieren**.
3. Dark und Light Theme müssen beide funktionieren (`body.light` überschreibt die Tokens).
4. Design-Prototypen wurden nach Auswahl des Layouts aus `main` entfernt; verbindliche Vorgaben stehen in diesem Dokument.

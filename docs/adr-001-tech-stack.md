# Architekturentscheidung: Tech-Stack (Sprint 2)

## Entscheidung

- **Sprache**: Python 3 (Standardbibliothek only)
- **Oberfläche**: CLI (`argparse`) als erstes Frontend
- **Speicher**: JSON-Datei (`projects.json`) als einfacher Datenspeicher
- **Struktur**: Paket `pp` unter `src/`, Tests mit `unittest`

## Begründung

- Kein Setup von Frameworks/Abhängigkeiten – schnellster Weg zu einem
  nutzbaren Inkrement
- JSON ist menschenlesbar, versionierbar und später leicht durch eine
  DB/REST-API ersetzbar
- CLI-first ermöglicht es, den Kern (Datenmodell, Speicher) sauber zu
  testen, bevor eine UI angebaut wird

## Datenmodell

- **Project**: `id`, `name`, `description`
- **Item** (Backlog-Eintrag): `id`, `project_id`, `title`, `status`
  (`offen`, `in_arbeit`, `pruefung`, `fertig`), `priority`
  (`hoch`, `mittel`, `niedrig`)

## Migration

- Später: REST-API (z. B. FastAPI) auf demselben Kern, dann UI

-- Issue #71: Benutzerdefinierte Zusatzfelder (Custom Fields) für Tasks

-- Globale Custom-Field-Definitionen (werden vom Admin definiert)
CREATE TABLE IF NOT EXISTS custom_field_definitions (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  field_type VARCHAR(20) NOT NULL DEFAULT 'text'
    CHECK (field_type IN ('text', 'number', 'date', 'checkbox', 'dropdown')),
  options TEXT[] NOT NULL DEFAULT '{}',  -- nur für field_type = 'dropdown'
  is_required BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_custom_field_defs_type ON custom_field_definitions(field_type);

-- Pro-Projekt Aktivierung von Custom Fields
CREATE TABLE IF NOT EXISTS project_custom_fields (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  field_definition_id INTEGER NOT NULL REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, field_definition_id)
);

CREATE INDEX IF NOT EXISTS idx_project_custom_fields_project ON project_custom_fields(project_id);

-- Task-Werte für Custom Fields als JSONB
-- Struktur: { "<field_definition_id>": <value>, ... }
-- Beispiel: { "1": "2026-12-24", "2": true, "3": "Wert aus Dropdown" }
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}';

-- Tracker-Feld-Mapping: GitHub/GitLab-Issue-Felder auf eigene Task-Felder mappen.
-- Nicht gemappte Felder landen beim Push als Markdown im Kommentarfeld (description/body).

-- Pro Tracker-Typ ('gitlab' | 'github') eine Mapping-Konfiguration (global, adminseitig gepflegt).
-- pp_field: eigenes Feld der Applikation
--   title, description, status, priority, issue_type, labels, due_date,
--   estimated_hours, spent_hours, assignee, milestone,
--   custom_field:<id> (Custom Fields, siehe custom_field_definitions)
-- tracker_field: Feld des externen Trackers
--   GitLab: title, description, state, labels, milestone, due_date, assignee_ids, weight, time_estimate, time_spent, epic, ...
--   GitHub: title, body, state, labels, milestone, assignees, projects, ...
-- direction: 'both' | 'push' | 'pull'
CREATE TABLE IF NOT EXISTS tracker_field_mappings (
  id SERIAL PRIMARY KEY,
  tracker_type VARCHAR(10) NOT NULL CHECK (tracker_type IN ('gitlab', 'github')),
  pp_field VARCHAR(100) NOT NULL,
  tracker_field VARCHAR(100) NOT NULL,
  direction VARCHAR(10) NOT NULL DEFAULT 'both' CHECK (direction IN ('both', 'push', 'pull')),
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tracker_type, pp_field)
);

CREATE INDEX IF NOT EXISTS idx_tracker_field_mappings_type ON tracker_field_mappings(tracker_type, position);

-- Rohdaten der externen Issues, damit beim Pull das Mapping live neu angewendet
-- werden kann (z. B. nach Mapping-Änderung) und ungemappte Felder als Markdown
-- ins Kommentarfeld übernommen werden können.
ALTER TABLE gitlab_issues ADD COLUMN IF NOT EXISTS raw_data JSONB;

-- Stabile externe Tracker-ID (GitHub node_id / GitLab global id) als zusaetzliches
-- Mapping-Feld. Ueberlebt Projekt-Renames/Transfers, im Gegensatz zur lokalen iid/number.
ALTER TABLE gitlab_issues ADD COLUMN IF NOT EXISTS tracker_node_id VARCHAR(128);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS tracker_node_id VARCHAR(128);

CREATE INDEX IF NOT EXISTS idx_gitlab_issues_tracker_node ON gitlab_issues(tracker_node_id);
CREATE INDEX IF NOT EXISTS idx_tasks_tracker_node ON tasks(tracker_node_id);

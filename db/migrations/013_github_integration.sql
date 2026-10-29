-- Issue #77/#78: GitHub/GitLab-Unterscheidung pro Projekt

-- Tracker-Typ pro Projekt: 'none', 'gitlab' oder 'github'
ALTER TABLE projects ADD COLUMN IF NOT EXISTS issue_tracker_type VARCHAR(10) NOT NULL DEFAULT 'none'
  CHECK (issue_tracker_type IN ('none', 'gitlab', 'github'));

-- GitHub-Repo (Format: "owner/repo")
ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_repo VARCHAR(255);

-- Globale GitHub-Settings (analog zu gitlab_settings)
CREATE TABLE IF NOT EXISTS github_settings (
  id SERIAL PRIMARY KEY,
  base_url VARCHAR(255) NOT NULL DEFAULT 'https://api.github.com',
  access_token VARCHAR(255) NOT NULL,
  service_account_username VARCHAR(255),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_github_settings_updated ON github_settings(updated_at);

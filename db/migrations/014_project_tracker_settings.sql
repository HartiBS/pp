-- Issue #82: Pro-Projekt GitHub/GitLab-Verbindungsdaten
-- Ermöglicht jedem Projekt eine eigene Tracker-Verbindung (statt nur global)

-- Pro-Projekt GitLab-Settings (überschreibt globale Settings)
CREATE TABLE IF NOT EXISTS project_gitlab_settings (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  base_url VARCHAR(255) NOT NULL,
  access_token VARCHAR(255) NOT NULL,
  service_account_username VARCHAR(255),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Pro-Projekt GitHub-Settings (überschreibt globale Settings)
CREATE TABLE IF NOT EXISTS project_github_settings (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  base_url VARCHAR(255) NOT NULL DEFAULT 'https://api.github.com',
  access_token VARCHAR(255) NOT NULL,
  service_account_username VARCHAR(255),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

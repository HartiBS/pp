CREATE TABLE IF NOT EXISTS gitlab_settings (
  id SERIAL PRIMARY KEY,
  base_url VARCHAR(500) NOT NULL,
  access_token VARCHAR(500) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS gitlab_project_id INTEGER;

CREATE TABLE IF NOT EXISTS gitlab_issues (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  gitlab_iid INTEGER NOT NULL,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  state VARCHAR(20) NOT NULL DEFAULT 'opened',
  web_url VARCHAR(1000),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, gitlab_iid)
);

CREATE INDEX IF NOT EXISTS idx_gitlab_issues_project ON gitlab_issues(project_id);

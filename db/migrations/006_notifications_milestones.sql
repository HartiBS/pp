CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL
    CHECK (type IN ('assigned', 'status_change', 'comment', 'mention', 'milestone')),
  title VARCHAR(255) NOT NULL,
  body TEXT,
  link VARCHAR(500),
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);

CREATE TABLE IF NOT EXISTS gitlab_milestones (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  gitlab_id INTEGER NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  state VARCHAR(20) NOT NULL DEFAULT 'active',
  due_date DATE,
  web_url VARCHAR(1000),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, gitlab_id)
);

CREATE INDEX IF NOT EXISTS idx_gitlab_milestones_project ON gitlab_milestones(project_id);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS milestone_id INTEGER REFERENCES gitlab_milestones(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_milestone ON tasks(milestone_id);
